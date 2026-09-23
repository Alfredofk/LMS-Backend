import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
import { hashPassword, verifyPassword } from '../../shared/auth.js';
import { AppError, notFound, unauthorized } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import {
    publicUser,
    issueRefreshToken,
    revokeAllRefreshTokens,
    authResponse,
} from '../auth/auth.service.js';

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
    // NISN and nothing else about the child comes back.
    guardianLinks: {
        select: {
            id: true,
            status: true,
            relationship: true,
            rejectionReason: true,
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
function schoolForMember(school, roles) {
    const principal = roles.some((role) => role.role === 'PRINCIPAL' && role.status === 'ACTIVE');
    return {
        id: school.id,
        name: school.name,
        schoolType: school.schoolType,
        durationYears: school.durationYears,
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

export { loadMembership, getMe, updateMe, changePassword };
