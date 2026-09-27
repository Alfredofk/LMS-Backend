import { prisma } from '../../shared/prisma.js';
import { runInSchool, runUnscoped } from '../../shared/tenantContext.js';
import { hashPassword, verifyPassword } from '../../shared/auth.js';
import { googleVerifier } from '../../shared/google.js';
import { recordAudit } from '../../shared/approval.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import {
    publicUser,
    issueRefreshToken,
    revokeAllRefreshTokens,
    authResponse,
} from '../auth/auth.service.js';
import { cancelPendingMembership, endMembership } from '../membership/membership.service.js';
import { discardKtp } from '../school/school.service.js';

const log = createLogger('Users');

// What a member is allowed to know about their own standing, and nothing more.
//
// A PENDING member sees their status, the name of the school they asked to join,
// and which roles they requested - that is the whole point of the endpoint, since
// otherwise a person waiting on approval has no way to tell whether anything is
// happening. They see no roster, no classes, no other member: this reads their
// own membership row by userId and never opens a school scope, so nothing
// tenant-owned is reachable from the token they hold (ADR-0001).
//
// Unscoped for the same reason buildAuthClaims is: a PENDING user's token carries
// no schoolId, so there is no ambient school for the extension to filter by.
const membershipSelect = {
    id: true,
    status: true,
    requestedAt: true,
    approvedAt: true,
    endedAt: true,
    endReason: true,
    school: {
        select: {
            id: true,
            name: true,
            schoolType: true,
            durationYears: true,
            latitude: true,
            longitude: true,
            deactivatedAt: true,
            deactivationReason: true,
        },
    },
    roles: {
        select: { role: true, status: true, rejectionReason: true },
        orderBy: { role: 'asc' },
    },
    // The member's own identifiers - a teacher reading back their NIP, a student
    // their NISN. Their own row only, so nothing about anybody else comes along.
    teacherProfile: { select: { nip: true, nuptk: true } },
    studentProfile: { select: { nisn: true, birthDate: true } },
    // A guardian's own claims, each with its id (to cancel a PENDING one) and the
    // reason it was turned down. The child's name is one the guardian typed; no
    // NISN and nothing else about the child comes back. endedAt tells a link that
    // is over - the child left the school - from one that still grants sight: an
    // ended link keeps its ACTIVE status as history.
    guardianLinks: {
        select: {
            id: true,
            status: true,
            relationship: true,
            rejectionReason: true,
            endedAt: true,
            studentProfile: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
        },
        orderBy: { createdAt: 'asc' },
    },
};

// A deactivated school has to say so here: buildAuthClaims() already hands this
// member a token with no school, and without deactivatedAt they would see an
// ACTIVE membership that opens nothing, with no hint why (ticket 14).
//
// Every member learns THAT it happened; only the Principal learns WHY. The
// reason is written by a platform admin to the person who runs the school, the
// same audience schoolView in school.service.js shows it to (owner, 2026-09-22).
//
// The school's point follows the same split (teaching-and-learning ticket 01):
// every member learns whether one is set - without it there is no self check-in -
// and only the Principal, who corrects it, sees the coordinates.
function schoolForMember(school, roles) {
    const principal = roles.some((role) => role.role === 'PRINCIPAL' && role.status === 'ACTIVE');
    return {
        id: school.id,
        name: school.name,
        schoolType: school.schoolType,
        durationYears: school.durationYears,
        hasLocation: school.latitude !== null && school.longitude !== null,
        location: principal && school.latitude !== null
            ? {
                latitude: school.latitude,
                longitude: school.longitude,
            }
            : null,
        deactivatedAt: school.deactivatedAt,
        deactivationReason: principal ? school.deactivationReason : null,
    };
}

async function loadMembership(userId) {
    return runUnscoped('reading a user own membership status', async () => {
        const membership = await prisma.schoolMembership.findFirst({
            where: { userId, status: { in: ['PENDING', 'ACTIVE'] } },
            select: membershipSelect,
        });

        // A rejected applicant has no pending or active row, and ticket 05 requires
        // the reason they were turned down to be visible to them. So when there is
        // nothing live, the most recent REJECTED, CANCELLED (their own withdrawal)
        // or LEFT (ticket 06 - with endReason when they were removed) row is shown
        // instead. The status field is what tells them apart, and none of them
        // grants anything anywhere (buildAuthClaims only reads ACTIVE).
        const decided =
            membership ??
            (await prisma.schoolMembership.findFirst({
                where: { userId, status: { in: ['REJECTED', 'CANCELLED', 'LEFT'] } },
                orderBy: { updatedAt: 'desc' },
                select: membershipSelect,
            }));

        if (!decided) return null;

        return {
            id: decided.id,
            status: decided.status,
            requestedAt: decided.requestedAt,
            approvedAt: decided.approvedAt,
            endedAt: decided.endedAt,
            endReason: decided.endReason,
            school: schoolForMember(decided.school, decided.roles),
            roles: decided.roles,
            teacher: decided.teacherProfile,
            student: decided.studentProfile,
            children: decided.guardianLinks.map((link) => ({
                id: link.id,
                status: link.status,
                relationship: link.relationship,
                rejectionReason: link.rejectionReason,
                endedAt: link.endedAt,
                student: { fullName: link.studentProfile.membership.user.fullName },
            })),
        };
    });
}

async function loadUser(userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw notFound('Account not found');
    return user;
}

async function getMe(userId) {
    const user = await loadUser(userId);
    return { user: publicUser(user), membership: await loadMembership(userId) };
}

async function updateMe(userId, { fullName }) {
    await loadUser(userId);

    const user = await prisma.user.update({
        where: { id: userId },
        data: { fullName },
    });

    return { user: publicUser(user), membership: await loadMembership(userId) };
}

// Changing a password signs out every device, then signs this one back in.
//
// Cutting them all is the point: if the reason for the change is that someone
// else had the old password, a sign-in they already hold must not outlive it. The
// caller gets a new pair back so the person doing the right thing is not signed
// out of the device they are typing on.
//
// The access token already in flight is untouched and lives out its remaining
// minutes - the accepted cost of a stateless access token, and why the tenant
// guards in guards.js read status from the database rather than from claims.
//
// The new sign-in keeps this device's remember-me choice, taken from the access
// token (`rem`) because that is all this request carries.
async function changePassword(userId, { currentPassword, newPassword }, { rememberMe = false } = {}) {
    const user = await loadUser(userId);

    // An account made through Google has nothing to compare against yet. Its
    // first password comes from forgot-password, which proves the inbox instead.
    if (!user.passwordHash) {
        throw new AppError(
            400,
            'PASSWORD_NOT_SET',
            'This account has no password yet. Use forgot-password to create one.'
        );
    }

    const matches = await verifyPassword(currentPassword, user.passwordHash);
    if (!matches) throw unauthorized('Current password is incorrect');

    const updated = await prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await hashPassword(newPassword) },
    });

    await revokeAllRefreshTokens(userId);
    const { token } = await issueRefreshToken(userId, { rememberMe });

    log.success(`Password changed for ${user.email}`);

    return authResponse(updated, token, { rememberMe });
}

// ---------------------------------------------------------------------------
// Deleting one's own account (ticket 11, ADR-0007)
// ---------------------------------------------------------------------------

// Leaving as a TEACHER or a STUDENT needs the Principal's approval (ADR-0006), so
// at a school still in operation they send a leave request first.
const NEEDS_LEAVE_REQUEST = ['TEACHER', 'STUDENT'];

const ENDED_BY_DELETION = 'Account deleted';
const ENDED_AT_DEACTIVATED_SCHOOL = 'Account deleted while the school was deactivated';
const REGISTRATION_CLOSED = 'The applicant deleted their account';

// The person proves it again: a stolen access token must not be enough to erase
// somebody. An account with a password gives it; one without (made through
// Google, ADR-0005) gives a fresh Google ID token for the account linked here.
async function confirmIdentity(user, { password, googleIdToken }) {
    if (user.passwordHash) {
        if (!password) throw badRequest('Confirm with your password');
        if (!(await verifyPassword(password, user.passwordHash))) {
            throw unauthorized('Password is incorrect');
        }
        return;
    }

    if (!googleIdToken) throw badRequest('This account has no password. Confirm with Google');
    const google = await googleVerifier.verify(googleIdToken);
    if (!user.googleSub || google.sub !== user.googleSub) {
        throw unauthorized('That Google account is not the one linked to this account');
    }
}

// Deleting an account removes the person's sign-in identity and keeps every
// school record. The User row stays - memberships, audit rows and, later, scores
// point at it - with the email released, Google unlinked, the password gone and
// every session ended. fullName stays, so a school's records still name who they
// are about. The same address, or the same Google account, can then register as
// a new User.
//
// What the person belongs to goes first, in the same transaction:
// - a join request still waiting is cancelled, as if they had taken it back;
// - an ACTIVE membership leaves through endMembership, the one Leaving function -
//   refused, while the school is in operation, for a Principal and for a teacher
//   or student (who send a leave request instead). At a deactivated school
//   nobody could approve that request, so anyone leaves here (owner, 2026-09-27);
// - a school registration still under review is closed, and its KTP deleted.
async function deleteAccount(userId, body) {
    const user = await loadUser(userId);
    await confirmIdentity(user, body);

    const membership = await runUnscoped('finding what an account being deleted belongs to', async () =>
        await prisma.schoolMembership.findFirst({
            where: { userId, status: { in: ['PENDING', 'ACTIVE'] } },
            select: {
                id: true,
                status: true,
                roles: { where: { status: 'ACTIVE' }, select: { role: true } },
                school: { select: { id: true, name: true, deactivatedAt: true } },
            },
        })
    );

    // Only a school in operation holds anyone back. A deactivated one can take no
    // leave request and needs no Principal while it is off; if it is restored
    // without one, the Platform Admin appoints another (owner, 2026-09-27).
    if (membership?.status === 'ACTIVE' && !membership.school.deactivatedAt) {
        const held = membership.roles.map((entry) => entry.role);
        if (held.includes('PRINCIPAL')) {
            throw conflict(
                'A school cannot be left without its Principal, so this account cannot be deleted yet'
            );
        }
        if (held.some((role) => NEEDS_LEAVE_REQUEST.includes(role))) {
            throw conflict(
                'A teacher or a student leaves with the Principal’s approval. Send a leave request ' +
                    'with your resignation letter first, then delete your account.'
            );
        }
    }

    const registration = await prisma.schoolRegistration.findFirst({
        where: { applicantUserId: userId, status: 'PENDING' },
        select: { id: true, ktpStoragePath: true },
    });

    const now = new Date();

    const write = () =>
        prisma.$transaction(async (tx) => {
            if (membership?.status === 'PENDING') {
                await cancelPendingMembership(tx, {
                    membershipId: membership.id,
                    schoolId: membership.school.id,
                    userId,
                    now,
                });
            }
            if (membership?.status === 'ACTIVE') {
                await endMembership(tx, {
                    membershipId: membership.id,
                    schoolId: membership.school.id,
                    action: 'LEAVE',
                    actorUserId: userId,
                    reason: membership.school.deactivatedAt
                        ? ENDED_AT_DEACTIVATED_SCHOOL
                        : ENDED_BY_DELETION,
                    now,
                });
            }

            // Unscoped even inside a school's scope: a registration predates any
            // school, and its audit row must not be stamped with this one.
            if (registration) {
                await runUnscoped('closing the school registration of an account being deleted', async () => {
                    const claimed = await tx.schoolRegistration.updateMany({
                        where: { id: registration.id, status: 'PENDING' },
                        data: {
                            status: 'REJECTED',
                            rejectionReason: REGISTRATION_CLOSED,
                            reviewedAt: now,
                            ktpStoragePath: null,
                        },
                    });
                    if (claimed.count === 0) {
                        throw conflict('Your school registration was decided meanwhile. Try again.');
                    }

                    await recordAudit({
                        subjectType: 'SchoolRegistration',
                        subjectId: registration.id,
                        action: 'CANCEL',
                        actorUserId: userId,
                        reason: REGISTRATION_CLOSED,
                        client: tx,
                    });
                });
            }

            // .invalid is a reserved TLD: the address can never receive mail, and
            // the id keeps it unique.
            const released = await tx.user.updateMany({
                where: { id: userId, deletedAt: null },
                data: {
                    email: `deleted+${userId}@deleted.invalid`,
                    googleSub: null,
                    passwordHash: null,
                    deletedAt: now,
                },
            });
            if (released.count === 0) throw conflict('This account is already deleted');

            await tx.refreshToken.updateMany({
                where: { userId, revokedAt: null },
                data: { revokedAt: now },
            });
            await tx.emailVerificationToken.updateMany({
                where: { userId, usedAt: null },
                data: { usedAt: now },
            });
            await tx.passwordResetToken.updateMany({
                where: { userId, usedAt: null },
                data: { usedAt: now },
            });
        });

    await (membership ? runInSchool(membership.school.id, membership.school.name, write) : write());

    // After the commit, as the admin's decision does it: a file that fails to go
    // is logged for a human, and cannot undo the deletion.
    if (registration) await discardKtp(registration.ktpStoragePath, registration.id);

    log.info(`Account ${userId} deleted`);

    return {
        deleted: true,
        membership: membership
            ? {
                school: { name: membership.school.name },
                status: membership.status === 'PENDING' ? 'CANCELLED' : 'LEFT',
            }
            : null,
        schoolRegistrationClosed: Boolean(registration),
    };
}

export { loadMembership, getMe, updateMe, changePassword, deleteAccount };
