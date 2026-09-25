import { prisma } from '../../shared/prisma.js';
import { runInSchool, runUnscoped } from '../../shared/tenantContext.js';
import { isValidGrade } from '../../shared/schoolType.js';
import { isPrincipal } from '../../shared/guards.js';
import { getStorage } from '../../shared/storage.js';
import { MIME } from '../../shared/upload.js';
import {
    assertRoleCombinationAllowed,
    assertMembershipRetryAllowed,
    assertRejectionReason,
    recordAudit,
} from '../../shared/approval.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('Membership');

const MEMBERSHIP_SUBJECT = 'SchoolMembership';
const ROLE_SUBJECT = 'MembershipRole';
const LINK_SUBJECT = 'GuardianStudent';
const LEAVE_SUBJECT = 'LeaveRequest';

// A role or a guardian link in one of these states is closed, and asking again
// moves the same row back to PENDING: both tables are unique on what was asked
// for, so a second row is not an option.
const REOPENABLE = ['REJECTED', 'CANCELLED'];

// Join by School Code, and the tiered approval behind it (ticket 05, ADR-0002).
//
// The shape of the whole module: a School Code LOCATES a school and grants
// nothing. What releases a role is a human who can check the applicant against a
// roster they hold outside this system - the Principal for a TEACHER, the
// homeroom teacher for a STUDENT or a GUARDIAN.
//
// Two scopes are in play, and the difference matters:
// - The applicant's token carries no schoolId (buildAuthClaims only fills it for
//   an ACTIVE membership), so requireAuth opened no school. Every tenant-owned
//   read or write here therefore names its own scope: runUnscoped() for "does this
//   person belong anywhere", runInSchool() for everything inside the school they
//   are asking to join.
// - The reviewer's token does carry a schoolId, so requireAuth already opened the
//   scope and their queries need no wrapper at all. A request id from another
//   school simply is not found - 404, never 403 (ADR-0001).
//
// Prisma queries are lazy: they run when awaited, not when built. Anything
// wrapped in runInSchool / runUnscoped must therefore await INSIDE the callback,
// or the query escapes the scope and the extension throws (ticket 04 found this
// the hard way).

// One message for every way a guardian's claim can fail: unknown NISN, a name
// that does not match, a child whose own membership is not active yet, a child
// with no class. Refusing at request time is the owner's decision (2026-09-20);
// the identical wording is what keeps the endpoint from becoming an oracle that
// answers "does this NISN attend this school?" one guess at a time.
//
// What still holds the guessing down: the caller must hold a verified account, and
// joinSchoolLimiter charges every failure (10/hour, keyed per user). What is
// missing, knowingly: a durable ceiling. That limiter's store is process memory
// and forgets on restart, unlike assertMembershipRetryAllowed().
const CHILD_NO_MATCH = 'Those child details do not match this school’s records';

// Names are compared, never listed. Indonesian names arrive with inconsistent
// spacing, capitals and punctuation ("Muhammad Rizky", "muhammad  rizky"), so both
// sides are folded to letters and single spaces before comparing. Nothing fuzzier
// than that: this is a security check, and a loose match would hand a stranger
// somebody else's child.
const normalizeName = (value) =>
    value
        .normalize('NFKD')
        .replace(/[^\p{L}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// What an applicant is allowed to learn from a School Code: the school's public
// identity, and nothing more. No roster, no class, no member count - and no id
// either, so the only way to name a school to this API is to hold its code.
//
// durationYears is part of that identity: it is what tells a three-year SMK from
// a four-year one, and so whether grade 13 is a choice the form should offer.
const publicSchoolView = (school) => ({
    name: school.name,
    schoolType: school.schoolType,
    durationYears: school.durationYears,
    city: school.city,
});

const applicantSelect = { select: { id: true, email: true, fullName: true } };

// The reviewer's view of a request: who is asking, which roles, the identifiers
// they typed, and the child they claim - everything the out-of-band check needs.
//
// canRelease per role is why a homeroom teacher can see that the TEACHER role on
// the same request is the Principal's to decide, not theirs.
const requestInclude = {
    user: applicantSelect,
    roles: { orderBy: { role: 'asc' } },
    joinRequest: true,
    guardianLinks: {
        include: {
            studentProfile: {
                select: {
                    id: true,
                    nisn: true,
                    membership: { select: { id: true, user: { select: { fullName: true } } } },
                },
            },
        },
    },
};

function requestView(membership, releasable = [], links = []) {
    const detail = membership.joinRequest;
    const canRelease = new Set(releasable.map((role) => role.role));
    const canReleaseLink = new Set(links.map((link) => link.id));

    return {
        id: membership.id,
        status: membership.status,
        requestedAt: membership.requestedAt,
        approvedAt: membership.approvedAt,
        applicant: membership.user
            ? {
                id: membership.user.id,
                email: membership.user.email,
                fullName: membership.user.fullName,
            }
            : undefined,
        roles: membership.roles.map((role) => ({
            role: role.role,
            status: role.status,
            rejectionReason: role.rejectionReason,
            canRelease: canRelease.has(role.role),
        })),
        student:
            detail && detail.nisn
                ? { nisn: detail.nisn, birthDate: detail.birthDate, gradeLevel: detail.gradeLevel }
                : null,
        teacher:
            detail && (detail.nip || detail.nuptk)
                ? { nip: detail.nip, nuptk: detail.nuptk }
                : null,
        children: (membership.guardianLinks ?? []).map((link) => ({
            id: link.id,
            status: link.status,
            relationship: link.relationship,
            rejectionReason: link.rejectionReason,
            canRelease: canReleaseLink.has(link.id),
            student: {
                id: link.studentProfile.id,
                nisn: link.studentProfile.nisn,
                fullName: link.studentProfile.membership.user.fullName,
            },
        })),
    };
}

// ---------------------------------------------------------------------------
// Applicant
// ---------------------------------------------------------------------------

// School is exempt from the tenant extension (it defines the tenant), so this
// reads without any scope. A code that resolves to nothing is a 404 with the same
// wording whatever went wrong - a code either locates a school or it does not.
async function resolveSchool(schoolCode) {
    const school = await prisma.school.findUnique({
        where: { schoolCode },
        select: {
            id: true,
            name: true,
            schoolType: true,
            durationYears: true,
            city: true,
            deactivatedAt: true,
        },
    });
    // A deactivated school's code stops resolving, with the same 404 an unknown
    // code gets (ticket 14). Saying "this school is switched off" would name a
    // school to somebody who is not in it, and there is nothing they could do with
    // the answer anyway - joining is not available either way.
    if (!school || school.deactivatedAt) throw notFound('No school uses that code');
    return school;
}

// Who may ask to join: a verified, live account that belongs nowhere yet.
//
// The membership question spans schools, so it runs unscoped - that is precisely
// what is being asked, "which school, if any". The partial unique index
// SchoolMembership_one_pending_or_active_per_user is the real ceiling; this check
// exists so the answer is a sentence instead of a constraint violation.
async function assertEligibleApplicant(userId) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true, emailVerifiedAt: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw notFound('Account not found');
    if (!user.emailVerifiedAt) {
        throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address first');
    }

    const held = await runUnscoped(
        'checking whether a user already belongs to a school',
        async () => {
            const found = await prisma.schoolMembership.findFirst({
                where: { userId, status: { in: ['PENDING', 'ACTIVE'] } },
                select: { id: true, status: true },
            });
            return found;
        }
    );

    if (held) {
        throw conflict(
            held.status === 'PENDING'
                ? 'You already have a join request waiting for approval'
                : 'You already belong to a school. Leave it first.'
        );
    }

    return user;
}

async function lookupSchool(userId, { schoolCode }) {
    await assertEligibleApplicant(userId);
    return publicSchoolView(await resolveSchool(schoolCode));
}

// The child a guardian claims. Runs inside the school's scope, so a NISN that
// belongs to another school is simply not there.
//
// Four different failures, one answer (see CHILD_NO_MATCH): no such NISN in this
// school, a name that does not match, a child whose own membership is not ACTIVE,
// and a child with no current class - that last one because the homeroom teacher
// of that class is who would release this request, and without a class there is
// nobody to ask.
//
// Who that homeroom teacher is comes back too, with the child's own membership:
// addRoles needs both when the claimant IS that homeroom teacher.
async function resolveChild({ childNisn, childFullName }) {
    const profile = await prisma.studentProfile.findFirst({
        where: { nisn: childNisn, membership: { status: 'ACTIVE' } },
        select: {
            id: true,
            membership: { select: { id: true, user: { select: { fullName: true } } } },
            classMemberships: {
                where: { endedAt: null },
                select: { class: { select: { homeroomTeacherMembershipId: true } } },
            },
        },
    });

    if (!profile) throw badRequest(CHILD_NO_MATCH);
    if (normalizeName(profile.membership.user.fullName) !== normalizeName(childFullName)) {
        throw badRequest(CHILD_NO_MATCH);
    }
    if (profile.classMemberships.length === 0) throw badRequest(CHILD_NO_MATCH);

    return {
        studentProfileId: profile.id,
        studentMembershipId: profile.membership.id,
        homeroomMembershipId: profile.classMemberships[0].class.homeroomTeacherMembershipId,
    };
}

// The join request itself. One SchoolMembership, PENDING, with one PENDING
// MembershipRole per requested role - each released on its own, by whoever is
// entitled to release it.
//
// A GUARDIAN request also creates its PENDING GuardianStudent here, because the
// child is resolved before the request is stored. TEACHER and STUDENT payloads go
// to JoinRequestDetail instead: their real profiles are only created at approval,
// and StudentProfile is unique on (schoolId, nisn), so writing one now would let a
// stranger reserve a real child's NISN forever.
async function requestJoin(userId, body) {
    await assertEligibleApplicant(userId);
    const school = await resolveSchool(body.schoolCode);
    const roles = assertRoleCombinationAllowed(body.roles);

    // The grade has to exist at this type of school: there is no grade 7 at an SD.
    if (roles.includes('STUDENT')) {
        const { gradeLevel } = body.student;
        if (!isValidGrade(school.schoolType, gradeLevel, school.durationYears)) {
            throw badRequest(`Grade ${gradeLevel} does not exist at a ${school.schoolType}`, {
                gradeLevel,
                schoolType: school.schoolType,
            });
        }
    }

    return runInSchool(school.id, school.name, async () => {
        await assertMembershipRetryAllowed({ userId, schoolId: school.id });

        const child = roles.includes('GUARDIAN') ? await resolveChild(body.guardian) : null;
        const detail = {
            nisn: body.student?.nisn ?? null,
            birthDate: body.student?.birthDate ?? null,
            gradeLevel: body.student?.gradeLevel ?? null,
            nip: body.teacher?.nip ?? null,
            nuptk: body.teacher?.nuptk ?? null,
        };
        const needsDetail = Boolean(body.student || body.teacher);

        try {
            const membership = await prisma.$transaction(async (tx) => {
                // schoolId is stamped by the tenant extension on every create.
                const created = await tx.schoolMembership.create({ data: { userId } });

                await tx.membershipRole.createMany({
                    data: roles.map((role) => ({ membershipId: created.id, role })),
                });

                if (needsDetail) {
                    await tx.joinRequestDetail.create({
                        data: { membershipId: created.id, ...detail },
                    });
                }

                if (child) {
                    await tx.guardianStudent.create({
                        data: {
                            guardianMembershipId: created.id,
                            studentProfileId: child.studentProfileId,
                            relationship: body.guardian.relationship,
                        },
                    });
                }

                await recordAudit({
                    schoolId: school.id,
                    subjectType: MEMBERSHIP_SUBJECT,
                    subjectId: created.id,
                    action: 'SUBMIT',
                    actorUserId: userId,
                    client: tx,
                });

                return created;
            });

            log.info(`Join request at ${school.name}: ${roles.join(' + ')}`);

            return {
                id: membership.id,
                status: membership.status,
                requestedAt: membership.requestedAt,
                roles,
                school: publicSchoolView(school),
            };
        } catch (error) {
            // The partial unique index, reached by two requests racing each other
            // past assertEligibleApplicant. The index is the rule; that check is
            // only the polite version of it.
            if (error?.code === 'P2002') {
                throw conflict('You already have a join request waiting for approval');
            }
            throw error;
        }
    });
}

// ---------------------------------------------------------------------------
// Guardian links - written the same way by every path that makes one
// ---------------------------------------------------------------------------

// The student is told. A guardian is never attached in silence (ticket 05) -
// in-app only, because mailer.js sends verification and password reset and
// nothing else.
function notifyGuardianLinked(tx, { studentMembershipId, guardianName, relationship }) {
    return tx.notification.create({
        data: {
            recipientMembershipId: studentMembershipId,
            type: 'GUARDIAN_LINK_APPROVED',
            title: 'A guardian was linked to your account',
            body: `${guardianName} (${relationship}) can now see your progress at this school.`,
        },
    });
}

// A guardian's claim on one child, PENDING for the child's homeroom teacher, or
// ACTIVE at once when the claimant IS that homeroom teacher (owner, 2026-09-23).
//
// @@unique([guardianMembershipId, studentProfileId]): a link turned down or
// cancelled before is moved back rather than duplicated, and loses its old
// reason and end on the way. Returns the link's id.
async function writeGuardianLink(
    tx,
    { membershipId, studentProfileId, relationship, priorLink, selfGranted, userId, now }
) {
    const data = {
        relationship,
        rejectionReason: null,
        endedAt: null,
        ...(selfGranted
            ? { status: 'ACTIVE', approvedByUserId: userId, approvedAt: now }
            : { status: 'PENDING', approvedByUserId: null, approvedAt: null }),
    };

    if (priorLink) {
        const claimed = await tx.guardianStudent.updateMany({
            where: { id: priorLink.id, status: { in: REOPENABLE } },
            data,
        });
        if (claimed.count === 0) throw conflict('Your link to that student changed meanwhile');
        return priorLink.id;
    }

    const created = await tx.guardianStudent.create({
        data: { guardianMembershipId: membershipId, studentProfileId, ...data },
    });
    return created.id;
}

// ---------------------------------------------------------------------------
// Member - adding a role to a membership already held
// ---------------------------------------------------------------------------

// A role added to an ACTIVE membership (owner, 2026-09-22): the Principal who
// also teaches, the teacher whose child has just enrolled, the guardian who is
// hired. The membership stays ACTIVE throughout; only the new role waits.
//
// It is released the way the same role would be on a fresh join request - the
// queue filters on PENDING roles, not on the membership's status, so a Principal
// sees a new TEACHER and the child's homeroom teacher sees a new GUARDIAN with no
// change to the reviewer side. Two exceptions are ACTIVE at once, the audit
// showing the same person submitting and approving:
// - the Principal's own TEACHER: nobody inside the school stands above them;
// - the GUARDIAN of a child in the claimant's own homeroom class (owner,
//   2026-09-23). The Principal named them that class's homeroom teacher, and
//   releasing a guardian for that class is exactly the authority it carries -
//   the release would otherwise fall to them and be refused as their own.
//
// The caller's token opened the school scope, so nothing here needs a wrapper.
async function addRoles(auth, body) {
    const membership = await prisma.schoolMembership.findFirst({
        where: { id: auth.membershipId, status: 'ACTIVE' },
        select: {
            id: true,
            user: { select: { fullName: true } },
            roles: { select: { id: true, role: true, status: true } },
            joinRequest: { select: { id: true } },
            teacherProfile: { select: { id: true } },
        },
    });
    if (!membership) throw notFound('Membership not found');

    const held = membership.roles.filter((role) => !REOPENABLE.includes(role.status));
    const requested = [...new Set(body.roles)];

    for (const role of requested) {
        const existing = held.find((entry) => entry.role === role);
        if (existing) {
            throw conflict(
                existing.status === 'PENDING'
                    ? `Your ${role} role is already waiting for approval`
                    : `You already hold the ${role} role`
            );
        }
    }

    // STUDENT stays exclusive: a student can add nothing, and nothing can be added to one.
    assertRoleCombinationAllowed([...held.map((role) => role.role), ...requested]);

    const principal = held.some((role) => role.role === 'PRINCIPAL' && role.status === 'ACTIVE');
    const child = requested.includes('GUARDIAN') ? await resolveChild(body.guardian) : null;
    const ownHomeroomChild = child?.homeroomMembershipId === membership.id;
    const now = new Date();

    const grantsItself = (role) =>
        (role === 'TEACHER' && principal) || (role === 'GUARDIAN' && ownHomeroomChild);

    // A child this member was linked to before and turned down for, or cancelled,
    // comes back through writeGuardianLink.
    const priorLink = child
        ? await prisma.guardianStudent.findFirst({
            where: { guardianMembershipId: membership.id, studentProfileId: child.studentProfileId },
            select: { id: true, status: true },
        })
        : null;
    if (priorLink && !REOPENABLE.includes(priorLink.status)) {
        throw conflict('You are already linked to that student');
    }

    try {
        await prisma.$transaction(async (tx) => {
            // The same row lock decideRequest takes, so a reviewer deciding an
            // older role on this membership and this request take turns.
            await tx.schoolMembership.updateMany({
                where: { id: membership.id },
                data: { updatedAt: now },
            });

            for (const role of requested) {
                const selfGranted = grantsItself(role);
                const data = selfGranted
                    ? {
                        status: 'ACTIVE',
                        approvedByUserId: auth.userId,
                        approvedAt: now,
                        rejectionReason: null,
                    }
                    : { status: 'PENDING', approvedByUserId: null, approvedAt: null, rejectionReason: null };

                // @@unique([membershipId, role]): a role turned down or cancelled
                // earlier keeps its row, so asking again moves that row back rather
                // than adding one.
                const closed = membership.roles.find(
                    (entry) => entry.role === role && REOPENABLE.includes(entry.status)
                );
                let roleId;
                if (closed) {
                    const claimed = await tx.membershipRole.updateMany({
                        where: { id: closed.id, status: { in: REOPENABLE } },
                        data,
                    });
                    if (claimed.count === 0) throw conflict(`Your ${role} role changed meanwhile`);
                    roleId = closed.id;
                } else {
                    const created = await tx.membershipRole.create({
                        data: { membershipId: membership.id, role, ...data },
                    });
                    roleId = created.id;
                }

                await recordAudit({
                    schoolId: auth.schoolId,
                    subjectType: ROLE_SUBJECT,
                    subjectId: roleId,
                    action: 'SUBMIT',
                    actorUserId: auth.userId,
                    client: tx,
                });

                if (selfGranted && role === 'TEACHER') {
                    const teacher = {
                        nip: body.teacher.nip ?? null,
                        nuptk: body.teacher.nuptk ?? null,
                    };
                    if (membership.teacherProfile) {
                        await tx.teacherProfile.updateMany({
                            where: { id: membership.teacherProfile.id },
                            data: teacher,
                        });
                    } else {
                        await tx.teacherProfile.create({
                            data: { membershipId: membership.id, ...teacher },
                        });
                    }
                }

                if (selfGranted) {
                    await recordAudit({
                        schoolId: auth.schoolId,
                        subjectType: ROLE_SUBJECT,
                        subjectId: roleId,
                        action: 'APPROVE',
                        actorUserId: auth.userId,
                        client: tx,
                    });
                }
            }

            // A TEACHER that waits parks its identifiers where decideRequest reads them.
            if (requested.includes('TEACHER') && !principal) {
                const teacher = {
                    nip: body.teacher.nip ?? null,
                    nuptk: body.teacher.nuptk ?? null,
                };
                if (membership.joinRequest) {
                    await tx.joinRequestDetail.updateMany({
                        where: { id: membership.joinRequest.id },
                        data: teacher,
                    });
                } else {
                    await tx.joinRequestDetail.create({
                        data: { membershipId: membership.id, ...teacher },
                    });
                }
            }

            if (child) {
                await writeGuardianLink(tx, {
                    membershipId: membership.id,
                    studentProfileId: child.studentProfileId,
                    relationship: body.guardian.relationship,
                    priorLink,
                    selfGranted: ownHomeroomChild,
                    userId: auth.userId,
                    now,
                });

                if (ownHomeroomChild) {
                    await notifyGuardianLinked(tx, {
                        studentMembershipId: child.studentMembershipId,
                        guardianName: membership.user.fullName,
                        relationship: body.guardian.relationship,
                    });
                }
            }
        });
    } catch (error) {
        throw translateUniqueViolation(error);
    }

    log.info(`Role(s) added at ${auth.schoolName}: ${requested.join(' + ')}`);

    const roles = await prisma.membershipRole.findMany({
        where: { membershipId: membership.id },
        select: { role: true, status: true, rejectionReason: true },
        orderBy: { role: 'asc' },
    });
    return { id: membership.id, status: 'ACTIVE', roles };
}

// What a guardian sees of their own link: the child's name they typed, never a
// NISN or anything else about the child.
const linkSelect = {
    id: true,
    status: true,
    relationship: true,
    rejectionReason: true,
    studentProfile: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
};

const linkView = (link) => ({
    id: link.id,
    status: link.status,
    relationship: link.relationship,
    rejectionReason: link.rejectionReason,
    student: { fullName: link.studentProfile.membership.user.fullName },
});

// A further child for a guardian who already has one (owner, 2026-09-23). The
// GUARDIAN role is held, so /me/roles answers 409; this asks for the link alone.
//
// Released like the first child: by the homeroom teacher of the class the child
// sits in, from the same /api/membership-requests queue - and ACTIVE at once when
// the claimant is that homeroom teacher. The role must already be ACTIVE: a link
// beside a PENDING role would be released with the role, by whoever releases it,
// which is a second child riding on the first one's approval.
async function linkChild(auth, body) {
    const membership = await prisma.schoolMembership.findFirst({
        where: { id: auth.membershipId, status: 'ACTIVE' },
        select: {
            id: true,
            user: { select: { fullName: true } },
            roles: { where: { role: 'GUARDIAN' }, select: { status: true } },
        },
    });
    if (!membership) throw notFound('Membership not found');

    const guardian = membership.roles[0];
    if (guardian?.status === 'PENDING') {
        throw conflict('Your GUARDIAN role is still waiting for approval');
    }
    if (guardian?.status !== 'ACTIVE') {
        throw conflict('Ask for the GUARDIAN role first');
    }

    const child = await resolveChild(body);
    const priorLink = await prisma.guardianStudent.findFirst({
        where: { guardianMembershipId: membership.id, studentProfileId: child.studentProfileId },
        select: { id: true, status: true },
    });
    if (priorLink && !REOPENABLE.includes(priorLink.status)) {
        throw conflict(
            priorLink.status === 'PENDING'
                ? 'Your link to that student is already waiting for approval'
                : 'You are already linked to that student'
        );
    }

    const selfGranted = child.homeroomMembershipId === membership.id;
    const now = new Date();
    let linkId;

    try {
        await prisma.$transaction(async (tx) => {
            // The row lock decideRequest takes, so this and a decision on an
            // earlier link take turns.
            await tx.schoolMembership.updateMany({
                where: { id: membership.id },
                data: { updatedAt: now },
            });

            linkId = await writeGuardianLink(tx, {
                membershipId: membership.id,
                studentProfileId: child.studentProfileId,
                relationship: body.relationship,
                priorLink,
                selfGranted,
                userId: auth.userId,
                now,
            });

            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: LINK_SUBJECT,
                subjectId: linkId,
                action: 'SUBMIT',
                actorUserId: auth.userId,
                client: tx,
            });

            if (selfGranted) {
                await recordAudit({
                    schoolId: auth.schoolId,
                    subjectType: LINK_SUBJECT,
                    subjectId: linkId,
                    action: 'APPROVE',
                    actorUserId: auth.userId,
                    client: tx,
                });
                await notifyGuardianLinked(tx, {
                    studentMembershipId: child.studentMembershipId,
                    guardianName: membership.user.fullName,
                    relationship: body.relationship,
                });
            }
        });
    } catch (error) {
        throw translateUniqueViolation(error);
    }

    log.info(`Further child claimed at ${auth.schoolName}${selfGranted ? ' (own homeroom class)' : ''}`);

    return linkView(await prisma.guardianStudent.findFirst({ where: { id: linkId }, select: linkSelect }));
}

// ---------------------------------------------------------------------------
// Cancellation - the person who asked, taking a PENDING request back
// ---------------------------------------------------------------------------

// Cancelled, not rejected (owner, 2026-09-23): nobody turned it down, so no
// reason is asked for and nothing counts against assertMembershipRetryAllowed,
// which reads REJECTED rows only. Every cancellation claims its rows with
// updateMany({ status: 'PENDING' }), so a reviewer deciding at the same moment
// and the person cancelling cannot both win - whoever commits second finds
// nothing PENDING and gets a 409.

// A whole join request. The applicant holds no school yet - their token opened
// no scope - so the membership is found unscoped and written inside its school,
// the way requestJoin does it. Afterwards they are free to ask anywhere.
async function cancelJoinRequest(userId) {
    const pending = await runUnscoped('finding the join request a user is cancelling', async () =>
        await prisma.schoolMembership.findFirst({
            where: { userId, status: 'PENDING' },
            select: { id: true, school: { select: { id: true, name: true } } },
        })
    );
    if (!pending) throw notFound('You have no join request waiting');

    const now = new Date();

    await runInSchool(pending.school.id, pending.school.name, async () => {
        await prisma.$transaction(async (tx) => {
            // The claim is also the lock: decideRequest updates this same row first.
            const claimed = await tx.schoolMembership.updateMany({
                where: { id: pending.id, status: 'PENDING' },
                data: { status: 'CANCELLED', endedAt: now },
            });
            if (claimed.count === 0) throw conflict('This join request has already been decided');

            await tx.membershipRole.updateMany({
                where: { membershipId: pending.id, status: 'PENDING' },
                data: { status: 'CANCELLED' },
            });
            await tx.guardianStudent.updateMany({
                where: { guardianMembershipId: pending.id, status: 'PENDING' },
                data: { status: 'CANCELLED', endedAt: now },
            });

            await recordAudit({
                schoolId: pending.school.id,
                subjectType: MEMBERSHIP_SUBJECT,
                subjectId: pending.id,
                action: 'CANCEL',
                actorUserId: userId,
                client: tx,
            });
        });

        log.info(`Join request cancelled at ${pending.school.name}`);
    });

    return { id: pending.id, status: 'CANCELLED', school: { name: pending.school.name } };
}

// One PENDING role on an ACTIVE membership, asked for through /me/roles. The
// membership stays ACTIVE. Cancelling GUARDIAN takes its PENDING child link with
// it - a link without its role would have nobody left to release it.
async function cancelRole(auth, role) {
    const pending = await prisma.membershipRole.findFirst({
        where: {
            membershipId: auth.membershipId,
            role,
            status: 'PENDING',
            membership: { status: 'ACTIVE' },
        },
        select: { id: true },
    });
    if (!pending) throw notFound(`You have no ${role} role waiting`);

    const now = new Date();

    await prisma.$transaction(async (tx) => {
        await tx.schoolMembership.updateMany({
            where: { id: auth.membershipId },
            data: { updatedAt: now },
        });

        const claimed = await tx.membershipRole.updateMany({
            where: { id: pending.id, status: 'PENDING' },
            data: { status: 'CANCELLED' },
        });
        if (claimed.count === 0) throw conflict(`Your ${role} role has already been decided`);

        if (role === 'GUARDIAN') {
            await tx.guardianStudent.updateMany({
                where: { guardianMembershipId: auth.membershipId, status: 'PENDING' },
                data: { status: 'CANCELLED', endedAt: now },
            });
        }

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: ROLE_SUBJECT,
            subjectId: pending.id,
            action: 'CANCEL',
            actorUserId: auth.userId,
            client: tx,
        });
    });

    log.info(`${role} role request cancelled at ${auth.schoolName}`);

    const roles = await prisma.membershipRole.findMany({
        where: { membershipId: auth.membershipId },
        select: { role: true, status: true, rejectionReason: true },
        orderBy: { role: 'asc' },
    });
    return { id: auth.membershipId, status: 'ACTIVE', roles };
}

// One PENDING further-child link. Only beside an ACTIVE GUARDIAN role: while the
// role itself waits, its link is part of that one request, and cancelRole is how
// it is taken back.
async function cancelLink(auth, linkId) {
    const link = await prisma.guardianStudent.findFirst({
        where: { id: linkId, guardianMembershipId: auth.membershipId, status: 'PENDING' },
        select: {
            id: true,
            guardianMembership: {
                select: { roles: { where: { role: 'GUARDIAN' }, select: { status: true } } },
            },
        },
    });
    // Another member's link, another school's, or one already decided: one answer.
    if (!link) throw notFound('No link of yours is waiting under that id');
    if (link.guardianMembership.roles[0]?.status !== 'ACTIVE') {
        throw conflict('Cancel the GUARDIAN role request instead');
    }

    const now = new Date();

    await prisma.$transaction(async (tx) => {
        await tx.schoolMembership.updateMany({
            where: { id: auth.membershipId },
            data: { updatedAt: now },
        });

        const claimed = await tx.guardianStudent.updateMany({
            where: { id: link.id, status: 'PENDING' },
            data: { status: 'CANCELLED', endedAt: now },
        });
        if (claimed.count === 0) throw conflict('That link has already been decided');

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: LINK_SUBJECT,
            subjectId: link.id,
            action: 'CANCEL',
            actorUserId: auth.userId,
            client: tx,
        });
    });

    log.info(`Child link cancelled at ${auth.schoolName}`);
    return linkView(await prisma.guardianStudent.findFirst({ where: { id: link.id }, select: linkSelect }));
}

// ---------------------------------------------------------------------------
// Leaving - access revoked, nothing deleted (ADR-0004, ticket 06)
// ---------------------------------------------------------------------------

const STUDENT_LEFT = 'The student has left the school';
const LAST_CHILD_LEFT = 'Your last linked student has left the school';

// A homeroom teacher of a class in an ACTIVE year cannot go (owner, 2026-09-24):
// the class would have nobody to release its students' requests. The Principal
// hands the class on first (PATCH /api/academics/classes/:id/homeroom). A CLOSED
// year's classes do not hold anyone back - nothing new happens in them.
async function assertNoActiveHomeroom(client, membershipId, whose) {
    const classes = await client.class.findMany({
        where: { homeroomTeacherMembershipId: membershipId, academicYear: { status: 'ACTIVE' } },
        select: { name: true, academicYear: { select: { label: true } } },
        orderBy: { name: 'asc' },
    });
    if (classes.length === 0) return;

    const names = classes.map((entry) => `${entry.name} (${entry.academicYear.label})`);
    throw conflict(
        `${whose} homeroom teacher of ${names.join(', ')}. The Principal has to hand ` +
            'these classes to another homeroom teacher first.',
        { classes: names }
    );
}

// A guardian whose links were just ended by a student leaving. Locked first, the
// way decideRequest locks, so two siblings leaving at the same moment take turns
// here: whoever comes second sees the first one's ended link, and the "last child"
// moment is never missed by both.
//
// - Any link still ACTIVE or PENDING: nothing changes.
// - A GUARDIAN role still PENDING with no link left has nobody to release it, so
//   it is rejected.
// - A membership holding another role (a teacher whose child left) stays.
// - Otherwise an ACTIVE membership is LEFT - it no longer grants sight of anyone
//   (ADR-0004) - and a PENDING one (a join request for that child) is REJECTED,
//   free to ask again.
async function releaseOrphanedGuardian(tx, membershipId, { actorUserId, schoolId, now }) {
    await tx.schoolMembership.updateMany({ where: { id: membershipId }, data: { updatedAt: now } });

    const remaining = await tx.guardianStudent.count({
        where: {
            guardianMembershipId: membershipId,
            status: { in: ['PENDING', 'ACTIVE'] },
            endedAt: null,
        },
    });
    if (remaining > 0) return;

    const guardian = await tx.schoolMembership.findFirst({
        where: { id: membershipId },
        select: { status: true, roles: { select: { id: true, role: true, status: true } } },
    });

    const pendingGuardian = guardian.roles.find(
        (role) => role.role === 'GUARDIAN' && role.status === 'PENDING'
    );
    if (pendingGuardian) {
        await tx.membershipRole.updateMany({
            where: { id: pendingGuardian.id, status: 'PENDING' },
            data: { status: 'REJECTED', approvedByUserId: actorUserId, rejectionReason: STUDENT_LEFT },
        });
        await recordAudit({
            schoolId,
            subjectType: ROLE_SUBJECT,
            subjectId: pendingGuardian.id,
            action: 'REJECT',
            actorUserId,
            reason: STUDENT_LEFT,
            client: tx,
        });
    }

    const otherRoles = guardian.roles.filter(
        (role) => role.role !== 'GUARDIAN' && ['PENDING', 'ACTIVE'].includes(role.status)
    );
    if (otherRoles.length > 0) return;

    if (guardian.status === 'ACTIVE') {
        await tx.schoolMembership.updateMany({
            where: { id: membershipId, status: 'ACTIVE' },
            data: { status: 'LEFT', endedAt: now, endReason: LAST_CHILD_LEFT },
        });
        await recordAudit({
            schoolId,
            subjectType: MEMBERSHIP_SUBJECT,
            subjectId: membershipId,
            action: 'LEAVE',
            actorUserId,
            reason: LAST_CHILD_LEFT,
            client: tx,
        });
    } else if (guardian.status === 'PENDING') {
        await tx.schoolMembership.updateMany({
            where: { id: membershipId, status: 'PENDING' },
            data: { status: 'REJECTED' },
        });
    }
}

// Ending one ACTIVE membership, by leaving or by removal. The one place this is
// done - ticket 11's account deletion calls it too - and always inside the
// caller's transaction and tenant scope.
//
// Revocation, never deletion: the StudentProfile, the ended class placement, the
// audit trail (and, once they exist, Scores and Report Cards) stay with the
// school. Role rows are left as they are, as history: access ends because the
// membership is no longer ACTIVE, which requireActiveMembership and
// hasActiveRole both read. Afterwards the person may ask any school again - the
// partial unique index only counts PENDING and ACTIVE rows.
async function endMembership(
    tx,
    { membershipId, schoolId, action, actorUserId, reason = null, now = new Date() }
) {
    // A request left waiting has nobody to wait for any more: the person's own
    // leaving cancels it, a removal turns it down with the removal's reason.
    const closed =
        action === 'REMOVE'
            ? { status: 'REJECTED', approvedByUserId: actorUserId, rejectionReason: reason }
            : { status: 'CANCELLED' };

    // The claim is also the row lock that decideRequest and addRoles take.
    const claimed = await tx.schoolMembership.updateMany({
        where: { id: membershipId, status: 'ACTIVE' },
        data: { status: 'LEFT', endedAt: now, endReason: reason },
    });
    if (claimed.count === 0) throw conflict('This membership has already ended');

    await tx.membershipRole.updateMany({
        where: { membershipId, status: 'PENDING' },
        data: closed,
    });

    // Their own links, if they are a guardian: none of them grants sight any more.
    await tx.guardianStudent.updateMany({
        where: { guardianMembershipId: membershipId, status: 'ACTIVE', endedAt: null },
        data: { endedAt: now },
    });
    await tx.guardianStudent.updateMany({
        where: { guardianMembershipId: membershipId, status: 'PENDING' },
        data: { ...closed, endedAt: now },
    });

    // Their teaching (ticket 08, owner 2026-09-24): a request still waiting closes
    // like any other; an ACTIVE assignment ends, so its slot is free for another
    // teacher - the slot index ignores ended rows - and the row stays as history.
    await tx.classSubject.updateMany({
        where: { teacherMembershipId: membershipId, status: 'PENDING' },
        data:
            action === 'REMOVE'
                ? {
                    status: 'REJECTED',
                    decidedByUserId: actorUserId,
                    decidedAt: now,
                    rejectionReason: reason,
                }
                : { status: 'CANCELLED' },
    });
    await tx.classSubject.updateMany({
        where: { teacherMembershipId: membershipId, status: 'ACTIVE', endedAt: null },
        data: { endedAt: now },
    });

    // Their own leave request (ticket 17). The approval path claims it before
    // calling here, so one still PENDING means the membership is ending some other
    // way - a removal that raced the request.
    await tx.leaveRequest.updateMany({
        where: { membershipId, status: 'PENDING' },
        data:
            action === 'REMOVE'
                ? {
                    status: 'REJECTED',
                    decidedByUserId: actorUserId,
                    decidedAt: now,
                    rejectionReason: reason,
                }
                : { status: 'CANCELLED' },
    });

    // A student: the placement ends, and so does every guardian's sight of them.
    const profile = await tx.studentProfile.findFirst({
        where: { membershipId },
        select: { id: true },
    });
    if (profile) {
        // A class move still waiting has no student left to move (ticket 16).
        // Closed before the placement, the order decideClassMove takes its rows
        // in, so the two never wait on each other.
        await tx.classMove.updateMany({
            where: { studentProfileId: profile.id, status: 'PENDING' },
            data: {
                status: 'REJECTED',
                decidedByUserId: actorUserId,
                decidedAt: now,
                rejectionReason: STUDENT_LEFT,
            },
        });

        await tx.classMembership.updateMany({
            where: { studentProfileId: profile.id, endedAt: null },
            data: { endedAt: now },
        });

        const links = await tx.guardianStudent.findMany({
            where: { studentProfileId: profile.id, status: { in: ['PENDING', 'ACTIVE'] }, endedAt: null },
            select: { id: true, status: true, guardianMembershipId: true },
        });
        for (const link of links) {
            await tx.guardianStudent.updateMany({
                where: { id: link.id },
                data:
                    link.status === 'ACTIVE'
                        ? { endedAt: now }
                        : {
                            status: 'REJECTED',
                            approvedByUserId: actorUserId,
                            rejectionReason: STUDENT_LEFT,
                            endedAt: now,
                        },
            });
        }

        // Sorted, so two leavers sharing guardians always lock them in one order.
        const guardians = [...new Set(links.map((link) => link.guardianMembershipId))].sort();
        for (const guardianMembershipId of guardians) {
            await releaseOrphanedGuardian(tx, guardianMembershipId, { actorUserId, schoolId, now });
        }
    }

    await recordAudit({
        schoolId,
        subjectType: MEMBERSHIP_SUBJECT,
        subjectId: membershipId,
        action,
        actorUserId,
        reason,
        client: tx,
    });
}

// Leaving as a TEACHER or a STUDENT needs the Principal's approval and a
// resignation letter (owner, 2026-09-24, ticket 17): a school keeps that letter
// on file. Holding either role is enough - a teacher who is also a guardian asks
// too. A member holding neither, a guardian, still leaves at once.
const NEEDS_LEAVE_APPROVAL = ['TEACHER', 'STUDENT'];

const needsLeaveApproval = (roles) =>
    roles.some((role) => NEEDS_LEAVE_APPROVAL.includes(role.role));

// The caller's own ACTIVE membership, for leaving or asking to. The Principal
// cannot do either (owner, 2026-09-24): a school is not left without its
// Principal, and no second one can exist yet - ticket 11 refuses the last
// Principal's account deletion for the same reason.
async function loadLeaver(auth) {
    const membership = await prisma.schoolMembership.findFirst({
        where: { id: auth.membershipId, status: 'ACTIVE' },
        select: { id: true, roles: { where: { status: 'ACTIVE' }, select: { role: true } } },
    });
    if (!membership) throw notFound('Membership not found');
    if (membership.roles.some((role) => role.role === 'PRINCIPAL')) {
        throw conflict('A school cannot be left without its Principal');
    }
    return membership;
}

// A member leaving on their own - only one who needs nobody's approval.
async function leaveSchool(auth) {
    const membership = await loadLeaver(auth);
    if (needsLeaveApproval(membership.roles)) {
        throw conflict(
            'A teacher or a student leaves with the Principal’s approval. Send a leave ' +
                'request with your resignation letter instead.'
        );
    }

    await prisma.$transaction(async (tx) => {
        await assertNoActiveHomeroom(tx, membership.id, 'You are');
        await endMembership(tx, {
            membershipId: membership.id,
            schoolId: auth.schoolId,
            action: 'LEAVE',
            actorUserId: auth.userId,
        });
    });

    log.info(`A member left ${auth.schoolName}`);
    return { id: membership.id, status: 'LEFT' };
}

// Taking somebody out of the school (handoff #58). The Principal's alone (owner,
// 2026-09-24): a homeroom teacher who released a student into the wrong class
// moves them instead (ticket 16), and only the Principal decides that someone
// does not belong here at all. Any member but a Principal; an id that is not an
// ACTIVE member here gets 404. The reason is required and shown to the person
// removed.
//
// A member whose leave request is waiting is refused: approving that request is
// the same ending, with their own letter on file.
async function removeMember(auth, membershipId, { reason }) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden('Only the Principal can do this');

    const member = await prisma.schoolMembership.findFirst({
        where: { id: membershipId, status: 'ACTIVE' },
        select: {
            id: true,
            roles: { where: { status: 'ACTIVE' }, select: { role: true } },
            leaveRequests: { where: { status: 'PENDING' }, select: { id: true } },
        },
    });
    if (!member || member.id === auth.membershipId) throw notFound('Member not found');
    if (member.roles.some((role) => role.role === 'PRINCIPAL')) {
        throw conflict('A Principal cannot be removed');
    }
    if (member.leaveRequests.length > 0) {
        throw conflict('This member has a leave request waiting. Decide that request instead.', {
            leaveRequestId: member.leaveRequests[0].id,
        });
    }

    await prisma.$transaction(async (tx) => {
        await assertNoActiveHomeroom(tx, member.id, 'This member is');
        await endMembership(tx, {
            membershipId: member.id,
            schoolId: auth.schoolId,
            action: 'REMOVE',
            actorUserId: auth.userId,
            reason,
        });
    });

    log.info(`A member was removed from ${auth.schoolName}`);
    return { id: member.id, status: 'LEFT', endReason: reason };
}

// ---------------------------------------------------------------------------
// Leave requests - a teacher or a student asking the Principal (ticket 17)
// ---------------------------------------------------------------------------

const LETTER_FOLDER = 'leave-letters';

// Nothing about the member themselves: they know who they are.
const ownLeaveView = (request) => ({
    id: request.id,
    status: request.status,
    reason: request.reason,
    requestedAt: request.requestedAt,
    decidedAt: request.decidedAt,
    rejectionReason: request.rejectionReason,
});

// The Principal's view: who is asking, as what, and where a student sits - what
// the letter in hand is checked against. The storage path never leaves the server.
const leaveSelect = {
    id: true,
    status: true,
    reason: true,
    requestedAt: true,
    decidedAt: true,
    rejectionReason: true,
    membership: {
        select: {
            id: true,
            status: true,
            user: { select: { fullName: true, email: true } },
            roles: { where: { status: 'ACTIVE' }, select: { role: true }, orderBy: { role: 'asc' } },
            studentProfile: {
                select: {
                    nisn: true,
                    classMemberships: {
                        where: { endedAt: null },
                        select: { class: { select: { id: true, name: true } } },
                    },
                },
            },
            teacherProfile: { select: { nip: true, nuptk: true } },
        },
    },
};

const leaveView = (request) => ({
    ...ownLeaveView(request),
    member: {
        membershipId: request.membership.id,
        status: request.membership.status,
        fullName: request.membership.user.fullName,
        email: request.membership.user.email,
        roles: request.membership.roles.map((entry) => entry.role),
        nisn: request.membership.studentProfile?.nisn ?? null,
        currentClass: request.membership.studentProfile?.classMemberships[0]?.class ?? null,
        nip: request.membership.teacherProfile?.nip ?? null,
        nuptk: request.membership.teacherProfile?.nuptk ?? null,
    },
});

async function loadLeaveRequest(id) {
    const request = await prisma.leaveRequest.findFirst({ where: { id }, select: leaveSelect });
    if (!request) throw notFound('Leave request not found');
    return request;
}

// The letter's bytes and type, read from the key's extension the way readKtp
// does - the key was built from the detected type, never from the upload's name.
async function readLetter(key) {
    const buffer = await getStorage().read(key);
    const type = key.slice(key.lastIndexOf('.') + 1);
    return { buffer, contentType: MIME[type] };
}

// The request itself, with its letter. Everything that can refuse is checked
// before the file is written, so a refusal leaves nothing in storage; a failure
// after it removes the file again, as submitRegistration does for a KTP.
//
// The homeroom rule is checked here and again at approval: asking is pointless
// while the class has nobody else to hand it to, and the Principal may hand it
// on in between.
async function submitLeaveRequest(auth, { reason }, file) {
    const membership = await loadLeaver(auth);
    if (!needsLeaveApproval(membership.roles)) {
        throw conflict('You need nobody’s approval to leave. Leave the school directly instead.');
    }
    await assertNoActiveHomeroom(prisma, membership.id, 'You are');

    const waiting = await prisma.leaveRequest.findFirst({
        where: { membershipId: membership.id, status: 'PENDING' },
        select: { id: true },
    });
    if (waiting) throw conflict('Your leave request is already waiting for the Principal');

    const storage = getStorage();
    const key = await storage.save(file.buffer, {
        folder: `${LETTER_FOLDER}/${auth.schoolId}`,
        originalName: `letter.${file.detectedType}`,
    });

    try {
        const created = await prisma.$transaction(async (tx) => {
            const row = await tx.leaveRequest.create({
                data: { membershipId: membership.id, reason, letterStoragePath: key },
                select: { id: true },
            });

            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: LEAVE_SUBJECT,
                subjectId: row.id,
                action: 'SUBMIT',
                actorUserId: auth.userId,
                client: tx,
            });
            return row;
        });

        log.info(`Leave request sent at ${auth.schoolName}`);
        return ownLeaveView(await loadLeaveRequest(created.id));
    } catch (error) {
        await storage.remove(key).catch((removeError) =>
            log.error(`Orphaned leave letter left in storage (${key}). Delete it by hand.`, removeError)
        );
        // The partial unique index, reached by two requests racing past the check above.
        if (error?.code === 'P2002') {
            throw conflict('Your leave request is already waiting for the Principal');
        }
        throw error;
    }
}

// Every request this member ever sent here, newest first.
async function listOwnLeaveRequests(auth) {
    const requests = await prisma.leaveRequest.findMany({
        where: { membershipId: auth.membershipId },
        select: leaveSelect,
        orderBy: { requestedAt: 'desc' },
    });
    return requests.map(ownLeaveView);
}

// Taking a waiting request back, claimed like every cancellation (ticket 05): a
// Principal deciding at the same moment and the member cancelling cannot both win.
async function cancelLeaveRequest(auth) {
    const waiting = await prisma.leaveRequest.findFirst({
        where: { membershipId: auth.membershipId, status: 'PENDING' },
        select: { id: true },
    });
    if (!waiting) throw notFound('You have no leave request waiting');

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.leaveRequest.updateMany({
            where: { id: waiting.id, status: 'PENDING' },
            data: { status: 'CANCELLED' },
        });
        if (claimed.count === 0) throw conflict('Your leave request has already been decided');

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: LEAVE_SUBJECT,
            subjectId: waiting.id,
            action: 'CANCEL',
            actorUserId: auth.userId,
            client: tx,
        });
    });

    log.info(`Leave request cancelled at ${auth.schoolName}`);
    return ownLeaveView(await loadLeaveRequest(waiting.id));
}

// A member's own letter, whatever became of the request. Anybody else's is 404.
async function readOwnLeaveLetter(auth, id) {
    const request = await prisma.leaveRequest.findFirst({
        where: { id, membershipId: auth.membershipId },
        select: { letterStoragePath: true },
    });
    if (!request) throw notFound('Leave request not found');
    return readLetter(request.letterStoragePath);
}

// ---- the Principal's side ---------------------------------------------------

async function assertPrincipal(auth) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden('Only the Principal can do this');
}

// The queue: PENDING unless asked otherwise, oldest first.
async function listLeaveRequests(auth, { status }) {
    await assertPrincipal(auth);

    const requests = await prisma.leaveRequest.findMany({
        where: { status },
        select: leaveSelect,
        orderBy: { requestedAt: 'asc' },
    });
    return requests.map(leaveView);
}

async function getLeaveRequest(auth, id) {
    await assertPrincipal(auth);
    return leaveView(await loadLeaveRequest(id));
}

async function readLeaveLetter(auth, id) {
    await assertPrincipal(auth);
    const request = await prisma.leaveRequest.findFirst({
        where: { id },
        select: { letterStoragePath: true },
    });
    if (!request) throw notFound('Leave request not found');
    return readLetter(request.letterStoragePath);
}

// Approve or reject, claimed with updateMany({ status: 'PENDING' }) so it happens
// once. Approval ends the membership in the same transaction, through the one
// Leaving function: LEFT with the request's reason as endReason, and everything
// ticket 06 ends with it. The audit then holds the request's APPROVE and the
// membership's LEAVE, both with the Principal as actor.
async function decideLeaveRequest(auth, id, { action, reason }) {
    await assertPrincipal(auth);

    let trimmed = null;
    if (action === 'REJECT') {
        assertRejectionReason('REJECT', reason);
        trimmed = reason.trim();
    }

    const request = await loadLeaveRequest(id);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.leaveRequest.updateMany({
            where: { id, status: 'PENDING' },
            data:
                action === 'APPROVE'
                    ? { status: 'ACTIVE', decidedByUserId: auth.userId, decidedAt: now }
                    : {
                        status: 'REJECTED',
                        decidedByUserId: auth.userId,
                        decidedAt: now,
                        rejectionReason: trimmed,
                    },
        });
        if (claimed.count === 0) throw conflict('This leave request has already been decided');

        if (action === 'APPROVE') {
            await assertNoActiveHomeroom(tx, request.membership.id, 'This member is');
            await endMembership(tx, {
                membershipId: request.membership.id,
                schoolId: auth.schoolId,
                action: 'LEAVE',
                actorUserId: auth.userId,
                reason: request.reason,
                now,
            });
        }

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: LEAVE_SUBJECT,
            subjectId: id,
            action,
            actorUserId: auth.userId,
            reason: trimmed,
            client: tx,
        });
    });

    log.info(`Leave request ${action === 'APPROVE' ? 'approved' : 'rejected'} at ${auth.schoolName}`);
    return leaveView(await loadLeaveRequest(id));
}

const approveLeaveRequest = (auth, id) => decideLeaveRequest(auth, id, { action: 'APPROVE' });

const rejectLeaveRequest = (auth, id, { reason } = {}) =>
    decideLeaveRequest(auth, id, { action: 'REJECT', reason });

// The Principal's list of the school's people. LEFT is here on purpose: a
// departed student's records stay with the school, and this is where the school
// still finds them (ticket 06's Done-when).
async function listMembers(auth, { status, role }) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden('Only the Principal can do this');

    const members = await prisma.schoolMembership.findMany({
        where: {
            status,
            ...(role ? { roles: { some: { role, status: 'ACTIVE' } } } : {}),
        },
        select: {
            id: true,
            status: true,
            approvedAt: true,
            endedAt: true,
            endReason: true,
            user: { select: { fullName: true } },
            roles: { where: { status: 'ACTIVE' }, select: { role: true }, orderBy: { role: 'asc' } },
            studentProfile: { select: { nisn: true } },
            teacherProfile: { select: { nip: true, nuptk: true } },
        },
        orderBy: { user: { fullName: 'asc' } },
    });

    return members.map((member) => ({
        membershipId: member.id,
        status: member.status,
        fullName: member.user.fullName,
        roles: member.roles.map((entry) => entry.role),
        nisn: member.studentProfile?.nisn ?? null,
        nip: member.teacherProfile?.nip ?? null,
        nuptk: member.teacherProfile?.nuptk ?? null,
        joinedAt: member.approvedAt,
        endedAt: member.endedAt,
        endReason: member.endReason,
    }));
}

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

// What this reviewer is entitled to release, resolved once per request.
//
// Homeroom teaching is not a role - it is Class.homeroomTeacherMembershipId - so
// this asks the classes, not the token. `grades` is what a STUDENT request is
// matched against (the applicant asked for a grade, not a class), and
// `studentProfileIds` is the current roster of those classes, which is what a
// GUARDIAN request is matched against.
async function reviewerScope(membershipId) {
    const [principal, classes] = await Promise.all([
        isPrincipal(membershipId),
        prisma.class.findMany({
            where: { homeroomTeacherMembershipId: membershipId },
            select: { id: true, name: true, gradeLevel: true },
        }),
    ]);

    let studentProfileIds = [];
    if (classes.length > 0) {
        const placements = await prisma.classMembership.findMany({
            where: { classId: { in: classes.map((entry) => entry.id) }, endedAt: null },
            select: { studentProfileId: true },
        });
        studentProfileIds = placements.map((entry) => entry.studentProfileId);
    }

    return {
        membershipId,
        principal,
        classes,
        grades: [...new Set(classes.map((entry) => entry.gradeLevel))],
        studentProfileIds,
    };
}

// Tiered approval, in one place (ticket 05):
//   TEACHER  -> the Principal.
//   STUDENT  -> a homeroom teacher of a class at the grade that was asked for.
//   GUARDIAN -> the homeroom teacher of the class the claimed child sits in.
//
// A grade with no class yet has no releaser, and that is honest rather than
// broken: until a Principal creates the class (ticket 07) there is nobody holding
// that roster.
//
// Nobody releases their own role. Before roles could be added to an ACTIVE
// membership this could not come up; now a homeroom teacher asking to be the
// guardian of a child in their own class would otherwise approve themselves.
// The two sanctioned exceptions - the Principal's own TEACHER, and a homeroom
// teacher's GUARDIAN for a child in their own class - never reach this queue:
// addRoles makes them ACTIVE directly.
function releasableRoles(scope, membership) {
    if (membership.id === scope.membershipId) return [];
    const detail = membership.joinRequest;
    const mine = (link) =>
        link.status === 'PENDING' && scope.studentProfileIds.includes(link.studentProfileId);

    return membership.roles.filter((role) => {
        if (role.status !== 'PENDING') return false;

        if (role.role === 'TEACHER') return scope.principal;
        if (role.role === 'STUDENT') {
            return detail?.gradeLevel != null && scope.grades.includes(detail.gradeLevel);
        }
        if (role.role === 'GUARDIAN') return (membership.guardianLinks ?? []).some(mine);

        return false;
    });
}

// The child links this reviewer decides: PENDING, for a child in one of their
// classes. They ride with the GUARDIAN role when that role is released now, or
// stand alone when it is already ACTIVE - a further child (linkChild). The same
// no-self-release rule as releasableRoles.
function releasableLinks(scope, membership, roles = releasableRoles(scope, membership)) {
    if (membership.id === scope.membershipId) return [];

    const guardian = membership.roles.find((role) => role.role === 'GUARDIAN');
    const decidable =
        guardian?.status === 'ACTIVE' || roles.some((role) => role.role === 'GUARDIAN');
    if (!decidable) return [];

    return (membership.guardianLinks ?? []).filter(
        (link) => link.status === 'PENDING' && scope.studentProfileIds.includes(link.studentProfileId)
    );
}

function visibleRequestFilter(scope, status) {
    const or = [];

    if (scope.principal) {
        or.push({ roles: { some: { role: 'TEACHER', status } } });
    }
    if (scope.grades.length > 0) {
        or.push({
            AND: [
                { roles: { some: { role: 'STUDENT', status } } },
                { joinRequest: { gradeLevel: { in: scope.grades } } },
            ],
        });
    }
    if (scope.studentProfileIds.length > 0) {
        or.push({
            AND: [
                { roles: { some: { role: 'GUARDIAN', status } } },
                { guardianLinks: { some: { studentProfileId: { in: scope.studentProfileIds } } } },
            ],
        });
        // A further child's link, whose GUARDIAN role is already ACTIVE.
        or.push({
            guardianLinks: { some: { status, studentProfileId: { in: scope.studentProfileIds } } },
        });
    }

    return or;
}

// The queue. Oldest first - a queue is worked from the front, like the platform
// admin's in ticket 04.
//
// A teacher who is neither Principal nor homeroom of anything gets an empty list
// rather than a 403: there is nothing for them to release, and nothing leaks
// either way.
async function listRequests(auth, { status }) {
    const scope = await reviewerScope(auth.membershipId);
    const or = visibleRequestFilter(scope, status);
    if (or.length === 0) return [];

    // A reviewer's own pending role is not in their queue (see releasableRoles).
    const memberships = await prisma.schoolMembership.findMany({
        where: { OR: or, id: { not: auth.membershipId } },
        include: requestInclude,
        orderBy: { requestedAt: 'asc' },
    });

    return memberships.map((membership) => {
        const roles = releasableRoles(scope, membership);
        return requestView(membership, roles, releasableLinks(scope, membership, roles));
    });
}

async function loadRequest(id) {
    const membership = await prisma.schoolMembership.findFirst({
        where: { id },
        include: requestInclude,
    });
    if (!membership) throw notFound('Join request not found');
    return membership;
}

// A request nobody in this reviewer's hands can release is 404 - the same 404 a
// request from another school gets. Inside one school that is a little strict, but
// it keeps one rule instead of two, and a 403 would be the confirmation ADR-0001
// refuses to give. The Principal is the exception: they run the school, so they
// may read the whole queue even where the release is a homeroom teacher's.
async function getRequest(auth, id) {
    const membership = await loadRequest(id);
    const scope = await reviewerScope(auth.membershipId);
    const releasable = releasableRoles(scope, membership);
    const links = releasableLinks(scope, membership, releasable);

    if (releasable.length === 0 && links.length === 0 && !scope.principal) {
        throw notFound('Join request not found');
    }
    return requestView(membership, releasable, links);
}

// Where a STUDENT lands. The applicant asked for a grade; the class is chosen
// here, by the person who just matched them against a roster.
//
// The class must be one this reviewer is homeroom of - anything else, including a
// class at another school, is 404 - and it must be at the grade that was
// requested, or a grade 7 applicant would quietly become a grade 9 student.
function resolveTargetClass(scope, membership, classId) {
    if (!classId) throw badRequest('Choose the class this student joins');

    const target = scope.classes.find((entry) => entry.id === classId);
    if (!target) throw notFound('Class not found');

    const requested = membership.joinRequest?.gradeLevel;
    if (requested != null && target.gradeLevel !== requested) {
        throw badRequest(
            `${target.name} is grade ${target.gradeLevel}, and this request asks for grade ${requested}`
        );
    }

    return target;
}

function translateUniqueViolation(error) {
    if (error?.code !== 'P2002') return error;

    const target = String(error.meta?.target ?? '');
    if (target.includes('nisn')) {
        return conflict('A student with this NISN already exists at this school');
    }
    if (target.includes('nip') || target.includes('nuptk')) {
        return conflict('A teacher with this NIP or NUPTK already exists at this school');
    }
    if (target.includes('guardian') || target.includes('studentProfileId')) {
        return conflict('This guardian is already linked to that student');
    }
    return error;
}

// Approve or reject: one function, because they differ only in what they write.
//
// Each role is claimed with updateMany({ status: 'PENDING' }) inside the
// transaction, which is what makes a decision happen exactly once - two reviewers
// clicking together both pass the read above, and only one of them moves the row.
//
// updateMany, not update, for every tenant-owned write here: the extension ANDs
// the school onto the where clause, and update() wants a unique one.
async function decideRequest(auth, id, { action, classId, reason }) {
    let trimmed = null;
    if (action === 'REJECT') {
        assertRejectionReason('REJECT', reason);
        trimmed = reason.trim();
    }

    const membership = await loadRequest(id);
    const scope = await reviewerScope(auth.membershipId);
    const releasable = releasableRoles(scope, membership);
    const links = releasableLinks(scope, membership, releasable);
    if (releasable.length === 0 && links.length === 0) throw notFound('Join request not found');

    // A link with no role released beside it is a further child on an ACTIVE
    // GUARDIAN role (linkChild): decided, and audited, on its own.
    const linksAlone = !releasable.some((role) => role.role === 'GUARDIAN');
    const releasing = [
        ...releasable.map((role) => role.role),
        ...(linksAlone && links.length > 0 ? ['child link'] : []),
    ];
    const detail = membership.joinRequest;
    const now = new Date();

    let target = null;
    if (action === 'APPROVE') {
        if (releasing.includes('STUDENT')) {
            target = resolveTargetClass(scope, membership, classId);
            if (!detail?.nisn) throw badRequest('This student request carries no NISN');
        }

        // STUDENT is exclusive, checked again here and not only at request time -
        // ticket 05 asks for exactly that. The set tested is what would be ACTIVE
        // after this decision, so a STUDENT role can never be released onto a
        // membership that already holds another.
        assertRoleCombinationAllowed([
            ...membership.roles.filter((role) => role.status === 'ACTIVE').map((role) => role.role),
            ...releasable.map((role) => role.role),
        ]);
    }

    // approvedAt stays null on a rejection: the column is named for the
    // approval path, and filling it would make "approvedAt != null"
    // stop meaning approved. When a rejection happened is in
    // ApprovalAudit, which is the record that matters (ADR-0003).
    const roleData =
        action === 'APPROVE'
            ? { status: 'ACTIVE', approvedByUserId: auth.userId, approvedAt: now }
            : { status: 'REJECTED', approvedByUserId: auth.userId, rejectionReason: trimmed };
    const linkData =
        action === 'APPROVE'
            ? { status: 'ACTIVE', approvedByUserId: auth.userId, approvedAt: now }
            : {
                status: 'REJECTED',
                approvedByUserId: auth.userId,
                rejectionReason: trimmed,
                endedAt: now,
            };

    try {
        await prisma.$transaction(async (tx) => {
            // Decisions on one membership take turns. A TEACHER + GUARDIAN request
            // has two releasers, and each claim below moves a different row, so
            // nothing else would stop the Principal and the homeroom teacher
            // deciding at the same moment - each then derives the membership's
            // status without the other's role, and two rejections strand it
            // PENDING with nothing left for anyone to decide.
            //
            // This write is the lock: Postgres holds the row until commit, so a
            // second decision waits here. A tenant-scoped updateMany rather than
            // SELECT ... FOR UPDATE, because raw SQL would step outside the
            // tenant extension.
            await tx.schoolMembership.updateMany({
                where: { id: membership.id },
                data: { updatedAt: now },
            });

            for (const role of releasable) {
                const claimed = await tx.membershipRole.updateMany({
                    where: { id: role.id, status: 'PENDING' },
                    data: roleData,
                });
                if (claimed.count === 0) {
                    throw conflict('This join request has already been decided');
                }

                if (action === 'APPROVE' && role.role === 'TEACHER') {
                    await tx.teacherProfile.create({
                        data: {
                            membershipId: membership.id,
                            nip: detail?.nip ?? null,
                            nuptk: detail?.nuptk ?? null,
                        },
                    });
                }

                if (action === 'APPROVE' && role.role === 'STUDENT') {
                    const profile = await tx.studentProfile.create({
                        data: {
                            membershipId: membership.id,
                            nisn: detail.nisn,
                            birthDate: detail.birthDate,
                        },
                    });
                    await tx.classMembership.create({
                        data: { classId: target.id, studentProfileId: profile.id },
                    });
                }

                await recordAudit({
                    schoolId: auth.schoolId,
                    subjectType: ROLE_SUBJECT,
                    subjectId: role.id,
                    action,
                    actorUserId: auth.userId,
                    reason: trimmed,
                    client: tx,
                });
            }

            // The child links, claimed like the roles: whoever commits second
            // finds nothing PENDING. Riding with a GUARDIAN role they share its
            // audit row; alone, each link is its own audited decision.
            for (const link of links) {
                const claimed = await tx.guardianStudent.updateMany({
                    where: { id: link.id, status: 'PENDING' },
                    data: linkData,
                });
                if (claimed.count === 0) {
                    throw conflict('This join request has already been decided');
                }

                if (action === 'APPROVE') {
                    await notifyGuardianLinked(tx, {
                        studentMembershipId: link.studentProfile.membership.id,
                        guardianName: membership.user.fullName,
                        relationship: link.relationship,
                    });
                }

                if (linksAlone) {
                    await recordAudit({
                        schoolId: auth.schoolId,
                        subjectType: LINK_SUBJECT,
                        subjectId: link.id,
                        action,
                        actorUserId: auth.userId,
                        reason: trimmed,
                        client: tx,
                    });
                }
            }

            // The membership follows its roles: ACTIVE as soon as one role is
            // active, REJECTED only when nothing is left pending or active. A
            // REJECTED row leaves the partial unique index, which is what lets the
            // person apply again - capped by assertMembershipRetryAllowed.
            //
            // Read again here, never taken from the snapshot loadRequest() made
            // before the lock: a decision that waited on it must see what the
            // one before it committed.
            const current = await tx.schoolMembership.findFirst({
                where: { id: membership.id },
                select: { status: true, approvedAt: true, roles: { select: { status: true } } },
            });
            const anyActive = current.roles.some((role) => role.status === 'ACTIVE');
            const anyPending = current.roles.some((role) => role.status === 'PENDING');

            let status = current.status;
            if (anyActive) status = 'ACTIVE';
            else if (!anyPending) status = 'REJECTED';

            if (status !== current.status) {
                await tx.schoolMembership.updateMany({
                    where: { id: membership.id },
                    data: {
                        status,
                        ...(status === 'ACTIVE' && !current.approvedAt
                            ? { approvedAt: now }
                            : {}),
                    },
                });
            }
        });
    } catch (error) {
        throw translateUniqueViolation(error);
    }

    log.info(
        `${action === 'APPROVE' ? 'Released' : 'Rejected'} ${releasing.join(' + ')} for ` +
            `${membership.user.fullName}${target ? ` into ${target.name}` : ''}`
    );

    const reloaded = await loadRequest(id);
    const scopeAfter = await reviewerScope(auth.membershipId);
    const rolesAfter = releasableRoles(scopeAfter, reloaded);
    return requestView(reloaded, rolesAfter, releasableLinks(scopeAfter, reloaded, rolesAfter));
}

const approveRequest = (auth, id, { classId } = {}) =>
    decideRequest(auth, id, { action: 'APPROVE', classId });

const rejectRequest = (auth, id, { reason } = {}) =>
    decideRequest(auth, id, { action: 'REJECT', reason });

// Bulk approve, one transaction each rather than one for all: a homeroom teacher
// releasing thirty students should not lose twenty-nine of them because the
// thirtieth has a NISN that is already taken. Sequential, so every failure is
// attributable, and only expected errors are repeated back to the caller.
async function bulkApprove(auth, { ids, classId }) {
    const results = [];

    for (const id of ids) {
        try {
            const request = await approveRequest(auth, id, { classId });
            results.push({ id, ok: true, status: request.status });
        } catch (error) {
            results.push({
                id,
                ok: false,
                error: {
                    code: error?.expected ? error.code : 'INTERNAL_ERROR',
                    message: error?.expected ? error.message : 'Something went wrong',
                },
            });
            if (!error?.expected) log.error(`Bulk approve failed for ${id}`, error);
        }
    }

    return results;
}

export {
    CHILD_NO_MATCH,
    normalizeName,
    lookupSchool,
    requestJoin,
    addRoles,
    linkChild,
    cancelJoinRequest,
    cancelRole,
    cancelLink,
    endMembership,
    leaveSchool,
    removeMember,
    submitLeaveRequest,
    listOwnLeaveRequests,
    cancelLeaveRequest,
    readOwnLeaveLetter,
    listLeaveRequests,
    getLeaveRequest,
    readLeaveLetter,
    approveLeaveRequest,
    rejectLeaveRequest,
    listMembers,
    listRequests,
    getRequest,
    approveRequest,
    rejectRequest,
    bulkApprove,
};
