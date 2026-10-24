import { prisma } from '../../shared/prisma.js';
import { runInSchool, runUnscoped } from '../../shared/tenantContext.js';
import { hashPassword, verifyPassword } from '../../shared/auth.js';
import { googleVerifier } from '../../shared/google.js';
import { recordAudit } from '../../shared/approval.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { publicUser, placesOf, placeOfAuth, revokeAllRefreshTokens, signIn } from '../auth/auth.service.js';
import { cancelPendingMembership, endMembership } from '../membership/membership.service.js';
import { discardKtp } from '../school/school.service.js';
import { letterheadView } from '../school/school.letterhead.js';
import { assertNotLastAdmin, endSeats } from '../governingBody/governingBody.admins.js';
import { discardRegistrationFiles } from '../governingBody/governingBody.service.js';

const log = createLogger('Users');

// What a member is allowed to know about their own standing, and nothing more.
//
// A PENDING member sees their status, the name of the school they asked to join,
// and which roles they requested - that is the whole point of the endpoint, since
// otherwise a person waiting on approval has no way to tell whether anything is
// happening. They see no roster, no classes, no other member: this reads their
// own membership rows by userId and never opens a school scope, so nothing
// tenant-owned is reachable from the token they hold (ADR-0001).
//
// Unscoped for the same reason buildAuthClaims is: a PENDING user's token carries
// no schoolId, so there is no ambient school for the extension to filter by - and
// since governing-body ticket 01 their rows span schools besides the token's.
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
            schoolCode: true,
            subdomain: true,
            schoolType: true,
            durationYears: true,
            latitude: true,
            longitude: true,
            timeZone: true,
            deactivatedAt: true,
            deactivationReason: true,
            address: true,
            phone: true,
            logoStorageKey: true,
        },
    },
    roles: {
        select: { role: true, status: true, rejectionReason: true },
        orderBy: { role: 'asc' },
    },
    // The member's own identifiers - a teacher reading back their NIP, a student
    // their NISN. Their own row only, so nothing about anybody else comes along.
    teacherProfile: { select: { nip: true, nuptk: true } },
    // A student's Class too: the open placement, at most one by the partial index.
    studentProfile: {
        select: {
            nisn: true,
            birthDate: true,
            classMemberships: {
                where: { endedAt: null },
                select: {
                    class: {
                        select: { id: true, name: true, gradeLevel: true, academicYear: { select: { label: true } } },
                    },
                },
                take: 1,
            },
        },
    },
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
// and only the Principal, who corrects it, sees the coordinates. The time zone is
// every member's: the frontend shows the school's times in it (ticket 07).
//
// The School Code goes to whoever readsSchoolCode says, and is null for the rest.
function schoolForMember(school, roles, { readsCode }) {
    const principal = roles.some((role) => role.role === 'PRINCIPAL' && role.status === 'ACTIVE');
    return {
        id: school.id,
        name: school.name,
        schoolCode: readsCode ? school.schoolCode : null,
        // Every member's, as the address they reach the School at (governing-body 02).
        subdomain: school.subdomain,
        schoolType: school.schoolType,
        durationYears: school.durationYears,
        timeZone: school.timeZone,
        hasLocation: school.latitude !== null && school.longitude !== null,
        location: principal && school.latitude !== null
            ? {
                latitude: school.latitude,
                longitude: school.longitude,
            }
            : null,
        deactivatedAt: school.deactivatedAt,
        deactivationReason: principal ? school.deactivationReason : null,
        // The Report Card's letterhead, the Principal's to set (grading-and-report-card
        // 10): read back as the location is, by them alone.
        letterhead: principal ? letterheadView(school) : null,
    };
}

// Who reads the School Code (owner, 2026-10-03): those who hand it to whoever should
// join - the Principal, a Vice Principal, and the homeroom teacher of a Class in an
// ACTIVE academic year, who releases that Class's students and guardians
// (ADR-0002). The code only finds the school; rotating it stays the Principal's.
//
// Only on an ACTIVE membership of a school still active: a LEFT member's roles keep
// their ACTIVE status as history (guards.js). The membership may be another
// school's than the token's (governing-body ticket 01), so the Class is looked up
// unscoped, by its schoolId by hand.
async function readsSchoolCode(membership) {
    if (membership.status !== 'ACTIVE' || membership.school.deactivatedAt) return false;

    const leader = membership.roles.some(
        (role) => (role.role === 'PRINCIPAL' || role.role === 'VICE_PRINCIPAL') && role.status === 'ACTIVE'
    );
    if (leader) return true;

    const homeroom = await runUnscoped('whether a member reads their school code', async () =>
        await prisma.class.findFirst({
            where: {
                schoolId: membership.school.id,
                homeroomTeacherMembershipId: membership.id,
                academicYear: { status: 'ACTIVE' },
            },
            select: { id: true },
        })
    );
    return Boolean(homeroom);
}

// A student's own identifiers and the Class they are in now, null between
// placements (a new academic year before the move, say).
function studentForMember(profile) {
    if (!profile) return null;
    const placement = profile.classMemberships[0];
    return {
        nisn: profile.nisn,
        birthDate: profile.birthDate,
        class: placement
            ? {
                id: placement.class.id,
                name: placement.class.name,
                gradeLevel: placement.class.gradeLevel,
                academicYear: placement.class.academicYear.label,
            }
            : null,
    };
}

const LIVE = ['PENDING', 'ACTIVE'];

// Every membership row of the person, newest first: what /users/me picks from. A
// person's rows are few - one or two per school they ever asked at.
async function membershipRowsOf(userId) {
    return runUnscoped('reading a user own memberships', async () =>
        await prisma.schoolMembership.findMany({
            where: { userId },
            select: membershipSelect,
            orderBy: { updatedAt: 'desc' },
        })
    );
}

// Live rows ahead of decided ones, each part newest first. A rejected applicant
// has no live row, and ticket 05 requires the reason they were turned down to be
// visible to them, so with nothing live the most recent REJECTED, CANCELLED
// (their own withdrawal) or LEFT (ticket 06 - with endReason when they were
// removed) row is shown instead. The status field is what tells them apart, and
// none of them grants anything anywhere (buildAuthClaims only reads ACTIVE).
const liveFirst = (rows) => [
    ...rows.filter((row) => LIVE.includes(row.status)),
    ...rows.filter((row) => !LIVE.includes(row.status)),
];

// /users/me's `membership`: the School the token is for (governing-body ticket 01,
// owner 2026-10-21), whatever has become of it since. A token for none gets:
// - while the person may open no School, the answer from before several
//   memberships - their live row, else the latest outcome - which is how an
//   applicant, a removed member and a deactivated school's member learn where
//   they stand;
// - the one School they may open, for a token minted before its approval;
// - null while they may open several Places and have chosen none.
// A token for a Governing Body seat (ticket 03) names no School: null, its body being
// `governingBody`'s.
function currentOf(rows, auth, places) {
    if (auth.membershipId) return rows.find((row) => row.id === auth.membershipId) ?? null;
    if (auth.governingBodyId || places.length > 1) return null;
    const [only] = places;
    if (only?.kind === 'SCHOOL') {
        return rows.find((row) => row.school.id === only.id && row.status === 'ACTIVE') ?? null;
    }
    if (only) return null;
    return liveFirst(rows)[0] ?? null;
}

// /users/me's `otherSchools` (owner, 2026-10-21; named so by the owner the same day,
// since an ACTIVE membership at a school switched off is no request): for every
// School the person may not open, their newest row there - a request waiting,
// turned down or cancelled, an end with its reason, or that ACTIVE membership. Live
// first, so a new request is not hidden behind an older outcome at its school.
function otherSchoolsOf(rows, places) {
    const shown = new Set(places.filter((place) => place.kind === 'SCHOOL').map((place) => place.id));
    const newest = [];
    for (const row of liveFirst(rows)) {
        if (shown.has(row.school.id)) continue;
        shown.add(row.school.id);
        newest.push(row);
    }
    return newest;
}

async function membershipView(row) {
    return {
        id: row.id,
        status: row.status,
        requestedAt: row.requestedAt,
        approvedAt: row.approvedAt,
        endedAt: row.endedAt,
        endReason: row.endReason,
        school: schoolForMember(row.school, row.roles, { readsCode: await readsSchoolCode(row) }),
        roles: row.roles,
        teacher: row.teacherProfile,
        student: studentForMember(row.studentProfile),
        children: row.guardianLinks.map((link) => ({
            id: link.id,
            status: link.status,
            relationship: link.relationship,
            rejectionReason: link.rejectionReason,
            endedAt: link.endedAt,
            student: { fullName: link.studentProfile.membership.user.fullName },
        })),
    };
}

async function loadUser(userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw notFound('Account not found');
    return user;
}

// The Governing Body a seat's token is for (governing-body ticket 03, owner
// 2026-10-22): the counterpart of `membership`, whatever has become of it since -
// `deactivatedAt` says when it was switched off.
async function governingBodyOf(governingBodyId) {
    return prisma.governingBody.findUnique({
        where: { id: governingBodyId },
        select: { id: true, name: true, kind: true, subdomain: true, deactivatedAt: true },
    });
}

// The account, whether it is a Platform Admin - read from the table as
// requirePlatformAdmin reads it, so the frontend knows to offer the admin's screens
// (2026-10-03) - and the memberships: the token's (currentOf), the Places the
// person may open, as the sign-in responses carry them, and what stands at every
// other school (otherSchoolsOf) - governing-body ticket 01.
//
// The phone number (ticket 23) is added here rather than to publicUser, so the
// sign-in responses keep their shape, as they did for isPlatformAdmin.
async function meOf(user, auth) {
    const [admin, rows, places, body] = await Promise.all([
        prisma.platformAdmin.findUnique({ where: { userId: user.id }, select: { id: true } }),
        membershipRowsOf(user.id),
        placesOf(user.id),
        auth.governingBodyId ? governingBodyOf(auth.governingBodyId) : null,
    ]);
    const current = currentOf(rows, auth, places);

    return {
        user: { ...publicUser(user), phone: user.phone },
        isPlatformAdmin: Boolean(admin),
        membership: current ? await membershipView(current) : null,
        governingBody: body,
        places,
        otherSchools: await Promise.all(otherSchoolsOf(rows, places).map(membershipView)),
    };
}

async function getMe(auth) {
    return meOf(await loadUser(auth.userId), auth);
}

async function updateMe(auth, { fullName, phone }) {
    await loadUser(auth.userId);

    const user = await prisma.user.update({
        where: { id: auth.userId },
        data: { fullName, phone },
    });

    return meOf(user, auth);
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
// The new sign-in keeps this device's remember-me choice and its Place, both
// taken from the access token (`rem`, and `schoolId` or `governingBodyId`) because
// that is all this request carries (governing-body tickets 01 and 03).
async function changePassword(auth, { currentPassword, newPassword }) {
    const { userId } = auth;
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
    const { answer } = await signIn(updated, { rememberMe: auth.rememberMe, place: placeOfAuth(auth) });

    log.success(`Password changed for ${user.email}`);

    return answer;
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
// What the person belongs to goes first, in the same transaction - every school
// they belong to or asked to join (governing-body ticket 01):
// - a join request still waiting is cancelled, as if they had taken it back;
// - an ACTIVE membership leaves through endMembership, the one Leaving function -
//   refused, while the school is in operation, for a Principal and for a teacher
//   or student (who send a leave request instead). At a deactivated school
//   nobody could approve that request, so anyone leaves here (owner, 2026-09-27);
// - a school registration still under review is closed, and its KTP deleted.
// One school holding them back refuses it all, and the refusal names every such
// school in its details.
//
// And at the Governing Bodies (governing-body ticket 04, ADR-0007):
// - the last admin of a live body is refused, every such body named;
// - an admin application waiting is cancelled, a seat ends LEFT (endSeats);
// - a Governing Body Registration under review is closed, and its KTP and proof
//   deleted (owner, 2026-10-24: invariant 7 of the spec holds on a deletion too).
async function deleteAccount(userId, body) {
    const user = await loadUser(userId);
    await confirmIdentity(user, body);

    const memberships = await runUnscoped('finding what an account being deleted belongs to', async () =>
        await prisma.schoolMembership.findMany({
            where: { userId, status: { in: LIVE } },
            select: {
                id: true,
                status: true,
                roles: { where: { status: 'ACTIVE' }, select: { role: true } },
                school: { select: { id: true, name: true, deactivatedAt: true } },
            },
            orderBy: { id: 'asc' },
        })
    );

    // Only a school in operation holds anyone back. A deactivated one can take no
    // leave request and needs no Principal while it is off; if it is restored
    // without one, the Platform Admin appoints another (owner, 2026-09-27).
    const holding = (roles) =>
        memberships
            .filter((entry) => entry.status === 'ACTIVE' && !entry.school.deactivatedAt)
            .filter((entry) => entry.roles.some((held) => roles.includes(held.role)))
            .map((entry) => entry.school.name);

    const headOf = holding(['PRINCIPAL']);
    if (headOf.length > 0) {
        throw conflict(
            'A school cannot be left without its Principal, so this account cannot be deleted yet',
            { schools: headOf }
        );
    }
    const leavesWithApproval = holding(NEEDS_LEAVE_REQUEST);
    if (leavesWithApproval.length > 0) {
        throw conflict(
            'A teacher or a student leaves with the Principal’s approval. Send a leave request ' +
                'with your resignation letter first, then delete your account.',
            { schools: leavesWithApproval }
        );
    }

    await assertNotLastAdmin(userId);

    const [registration, bodyRegistration] = await Promise.all([
        prisma.schoolRegistration.findFirst({
            where: { applicantUserId: userId, status: 'PENDING' },
            select: { id: true, ktpStoragePath: true },
        }),
        prisma.governingBodyRegistration.findFirst({
            where: { applicantUserId: userId, status: 'PENDING' },
            select: { id: true, ktpStoragePath: true, proofStoragePath: true },
        }),
    ]);

    const now = new Date();
    let seats = [];

    await prisma.$transaction(async (tx) => {
        // Each inside its own school's scope: the tenant extension reads the scope
        // at every query, so one transaction spans the schools.
        for (const membership of memberships) {
            await runInSchool(membership.school.id, membership.school.name, async () => {
                if (membership.status === 'PENDING') {
                    await cancelPendingMembership(tx, {
                        membershipId: membership.id,
                        schoolId: membership.school.id,
                        userId,
                        now,
                    });
                    return;
                }
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

        // The same for a Governing Body Registration, both its files with it, and then
        // the seats - all above tenancy, their audit rows stamped with no school.
        await runUnscoped('ending what an account being deleted holds at governing bodies', async () => {
            if (bodyRegistration) {
                const claimed = await tx.governingBodyRegistration.updateMany({
                    where: { id: bodyRegistration.id, status: 'PENDING' },
                    data: {
                        status: 'REJECTED',
                        rejectionReason: REGISTRATION_CLOSED,
                        reviewedAt: now,
                        ktpStoragePath: null,
                        proofStoragePath: null,
                    },
                });
                if (claimed.count === 0) {
                    throw conflict('Your governing body registration was decided meanwhile. Try again.');
                }

                await recordAudit({
                    subjectType: 'GoverningBodyRegistration',
                    subjectId: bodyRegistration.id,
                    action: 'CANCEL',
                    actorUserId: userId,
                    reason: REGISTRATION_CLOSED,
                    client: tx,
                });
            }

            seats = await endSeats(tx, { userId, now });
        });

        // .invalid is a reserved TLD: the address can never receive mail, and
        // the id keeps it unique. The phone number goes with it (ticket 23):
        // nothing keeps a way to reach a person who asked to be deleted.
        const released = await tx.user.updateMany({
            where: { id: userId, deletedAt: null },
            data: {
                email: `deleted+${userId}@deleted.invalid`,
                googleSub: null,
                passwordHash: null,
                phone: null,
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

    // After the commit, as the admin's decision does it: a file that fails to go
    // is logged for a human, and cannot undo the deletion.
    if (registration) await discardKtp(registration.ktpStoragePath, registration.id);
    if (bodyRegistration) await discardRegistrationFiles(bodyRegistration);

    log.info(`Account ${userId} deleted`);

    const ended = memberships.map((entry) => ({
        school: { name: entry.school.name },
        status: entry.status === 'PENDING' ? 'CANCELLED' : 'LEFT',
    }));

    return {
        deleted: true,
        // `membership` keeps its shape from before several memberships for one who
        // had at most one; `memberships` names them all (governing-body ticket 01).
        membership: ended.length === 1 ? ended[0] : null,
        memberships: ended,
        schoolRegistrationClosed: Boolean(registration),
        // Governing-body ticket 04: each seat ended, and the body's registration closed.
        governingBodies: seats,
        governingBodyRegistrationClosed: Boolean(bodyRegistration),
    };
}

export { getMe, updateMe, changePassword, deleteAccount };
