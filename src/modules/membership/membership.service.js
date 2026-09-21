import { prisma } from '../../shared/prisma.js';
import { runInSchool, runUnscoped } from '../../shared/tenantContext.js';
import { isValidGrade } from '../../shared/schoolType.js';
import { isPrincipal } from '../../shared/guards.js';
import {
    assertRoleCombinationAllowed,
    assertMembershipRetryAllowed,
    assertRejectionReason,
    recordAudit,
} from '../../shared/approval.js';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('Membership');

const MEMBERSHIP_SUBJECT = 'SchoolMembership';
const ROLE_SUBJECT = 'MembershipRole';

/*
  Join by School Code, and the tiered approval behind it (ticket 05, ADR-0002).

  The shape of the whole module: a School Code LOCATES a school and grants
  nothing. What releases a role is a human who can check the applicant against a
  roster they hold outside this system - the Principal for a TEACHER, the
  homeroom teacher for a STUDENT or a GUARDIAN.

  Two scopes are in play, and the difference matters:
  - The applicant's token carries no schoolId (buildAuthClaims only fills it for
    an ACTIVE membership), so requireAuth opened no school. Every tenant-owned
    read or write here therefore names its own scope: runUnscoped() for "does this
    person belong anywhere", runInSchool() for everything inside the school they
    are asking to join.
  - The reviewer's token does carry a schoolId, so requireAuth already opened the
    scope and their queries need no wrapper at all. A request id from another
    school simply is not found - 404, never 403 (ADR-0001).

  Prisma queries are lazy: they run when awaited, not when built. Anything
  wrapped in runInSchool / runUnscoped must therefore await INSIDE the callback,
  or the query escapes the scope and the extension throws (ticket 04 found this
  the hard way).
*/

/*
  One message for every way a guardian's claim can fail: unknown NISN, a name
  that does not match, a child whose own membership is not active yet, a child
  with no class. Refusing at request time is the owner's decision (2026-09-20);
  the identical wording is what keeps the endpoint from becoming an oracle that
  answers "does this NISN attend this school?" one guess at a time.

  What still holds the guessing down: the caller must hold a verified account, and
  joinSchoolLimiter charges every failure (10/hour, keyed per user). What is
  missing, knowingly: a durable ceiling. That limiter's store is process memory
  and forgets on restart, unlike assertMembershipRetryAllowed().
*/
const CHILD_NO_MATCH = 'Those child details do not match this school’s records';

/*
  Names are compared, never listed. Indonesian names arrive with inconsistent
  spacing, capitals and punctuation ("Muhammad Rizky", "muhammad  rizky"), so both
  sides are folded to letters and single spaces before comparing. Nothing fuzzier
  than that: this is a security check, and a loose match would hand a stranger
  somebody else's child.
*/
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

/*
  What an applicant is allowed to learn from a School Code: the school's public
  identity, and nothing more. No roster, no class, no member count - and no id
  either, so the only way to name a school to this API is to hold its code.
*/
const publicSchoolView = (school) => ({
    name: school.name,
    schoolType: school.schoolType,
    city: school.city,
});

const applicantSelect = { select: { id: true, email: true, fullName: true } };

/*
  The reviewer's view of a request: who is asking, which roles, the identifiers
  they typed, and the child they claim - everything the out-of-band check needs.

  canRelease per role is why a homeroom teacher can see that the TEACHER role on
  the same request is the Principal's to decide, not theirs.
*/
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

function requestView(membership, releasable = []) {
    const detail = membership.joinRequest;
    const canRelease = new Set(releasable.map((role) => role.role));

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

/*
  School is exempt from the tenant extension (it defines the tenant), so this
  reads without any scope. A code that resolves to nothing is a 404 with the same
  wording whatever went wrong - a code either locates a school or it does not.
*/
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
    /*
      A deactivated school's code stops resolving, with the same 404 an unknown
      code gets (ticket 14). Saying "this school is switched off" would name a
      school to somebody who is not in it, and there is nothing they could do with
      the answer anyway - joining is not available either way.
    */
    if (!school || school.deactivatedAt) throw notFound('No school uses that code');
    return school;
}

/*
  Who may ask to join: a verified, live account that belongs nowhere yet.

  The membership question spans schools, so it runs unscoped - that is precisely
  what is being asked, "which school, if any". The partial unique index
  SchoolMembership_one_pending_or_active_per_user is the real ceiling; this check
  exists so the answer is a sentence instead of a constraint violation.
*/
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

/*
  The child a guardian claims. Runs inside the school's scope, so a NISN that
  belongs to another school is simply not there.

  Four different failures, one answer (see CHILD_NO_MATCH): no such NISN in this
  school, a name that does not match, a child whose own membership is not ACTIVE,
  and a child with no current class - that last one because the homeroom teacher
  of that class is who would release this request, and without a class there is
  nobody to ask.
*/
async function resolveChild({ childNisn, childFullName }) {
    const profile = await prisma.studentProfile.findFirst({
        where: { nisn: childNisn, membership: { status: 'ACTIVE' } },
        select: {
            id: true,
            membership: { select: { user: { select: { fullName: true } } } },
            classMemberships: { where: { endedAt: null }, select: { id: true } },
        },
    });

    if (!profile) throw badRequest(CHILD_NO_MATCH);
    if (normalizeName(profile.membership.user.fullName) !== normalizeName(childFullName)) {
        throw badRequest(CHILD_NO_MATCH);
    }
    if (profile.classMemberships.length === 0) throw badRequest(CHILD_NO_MATCH);

    return { studentProfileId: profile.id };
}

/*
  The join request itself. One SchoolMembership, PENDING, with one PENDING
  MembershipRole per requested role - each released on its own, by whoever is
  entitled to release it.

  A GUARDIAN request also creates its PENDING GuardianStudent here, because the
  child is resolved before the request is stored. TEACHER and STUDENT payloads go
  to JoinRequestDetail instead: their real profiles are only created at approval,
  and StudentProfile is unique on (schoolId, nisn), so writing one now would let a
  stranger reserve a real child's NISN forever.
*/
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
            /*
              The partial unique index, reached by two requests racing each other
              past assertEligibleApplicant. The index is the rule; that check is
              only the polite version of it.
            */
            if (error?.code === 'P2002') {
                throw conflict('You already have a join request waiting for approval');
            }
            throw error;
        }
    });
}

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

/*
  What this reviewer is entitled to release, resolved once per request.

  Homeroom teaching is not a role - it is Class.homeroomTeacherMembershipId - so
  this asks the classes, not the token. `grades` is what a STUDENT request is
  matched against (the applicant asked for a grade, not a class), and
  `studentProfileIds` is the current roster of those classes, which is what a
  GUARDIAN request is matched against.
*/
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
        principal,
        classes,
        grades: [...new Set(classes.map((entry) => entry.gradeLevel))],
        studentProfileIds,
    };
}

/*
  Tiered approval, in one place (ticket 05):
    TEACHER  -> the Principal.
    STUDENT  -> a homeroom teacher of a class at the grade that was asked for.
    GUARDIAN -> the homeroom teacher of the class the claimed child sits in.

  A grade with no class yet has no releaser, and that is honest rather than
  broken: until a Principal creates the class (ticket 07) there is nobody holding
  that roster.
*/
function releasableRoles(scope, membership) {
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
    }

    return or;
}

/*
  The queue. Oldest first - a queue is worked from the front, like the platform
  admin's in ticket 04.

  A teacher who is neither Principal nor homeroom of anything gets an empty list
  rather than a 403: there is nothing for them to release, and nothing leaks
  either way.
*/
async function listRequests(auth, { status }) {
    const scope = await reviewerScope(auth.membershipId);
    const or = visibleRequestFilter(scope, status);
    if (or.length === 0) return [];

    const memberships = await prisma.schoolMembership.findMany({
        where: { OR: or },
        include: requestInclude,
        orderBy: { requestedAt: 'asc' },
    });

    return memberships.map((membership) =>
        requestView(membership, releasableRoles(scope, membership))
    );
}

async function loadRequest(id) {
    const membership = await prisma.schoolMembership.findFirst({
        where: { id },
        include: requestInclude,
    });
    if (!membership) throw notFound('Join request not found');
    return membership;
}

/*
  A request nobody in this reviewer's hands can release is 404 - the same 404 a
  request from another school gets. Inside one school that is a little strict, but
  it keeps one rule instead of two, and a 403 would be the confirmation ADR-0001
  refuses to give. The Principal is the exception: they run the school, so they
  may read the whole queue even where the release is a homeroom teacher's.
*/
async function getRequest(auth, id) {
    const membership = await loadRequest(id);
    const scope = await reviewerScope(auth.membershipId);
    const releasable = releasableRoles(scope, membership);

    if (releasable.length === 0 && !scope.principal) throw notFound('Join request not found');
    return requestView(membership, releasable);
}

/*
  Where a STUDENT lands. The applicant asked for a grade; the class is chosen
  here, by the person who just matched them against a roster.

  The class must be one this reviewer is homeroom of - anything else, including a
  class at another school, is 404 - and it must be at the grade that was
  requested, or a grade 7 applicant would quietly become a grade 9 student.
*/
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

/*
  Approve or reject: one function, because they differ only in what they write.

  Each role is claimed with updateMany({ status: 'PENDING' }) inside the
  transaction, which is what makes a decision happen exactly once - two reviewers
  clicking together both pass the read above, and only one of them moves the row.

  updateMany, not update, for every tenant-owned write here: the extension ANDs
  the school onto the where clause, and update() wants a unique one.
*/
async function decideRequest(auth, id, { action, classId, reason }) {
    let trimmed = null;
    if (action === 'REJECT') {
        assertRejectionReason('REJECT', reason);
        trimmed = reason.trim();
    }

    const membership = await loadRequest(id);
    const scope = await reviewerScope(auth.membershipId);
    const releasable = releasableRoles(scope, membership);
    if (releasable.length === 0) throw notFound('Join request not found');

    const releasing = releasable.map((role) => role.role);
    const detail = membership.joinRequest;
    const now = new Date();

    let target = null;
    if (action === 'APPROVE') {
        if (releasing.includes('STUDENT')) {
            target = resolveTargetClass(scope, membership, classId);
            if (!detail?.nisn) throw badRequest('This student request carries no NISN');
        }

        /*
          STUDENT is exclusive, checked again here and not only at request time -
          ticket 05 asks for exactly that. The set tested is what would be ACTIVE
          after this decision, so a STUDENT role can never be released onto a
          membership that already holds another.
        */
        assertRoleCombinationAllowed([
            ...membership.roles.filter((role) => role.status === 'ACTIVE').map((role) => role.role),
            ...releasing,
        ]);
    }

    const roleData =
        action === 'APPROVE'
            ? { status: 'ACTIVE', approvedByUserId: auth.userId, approvedAt: now }
            : /*
                 approvedAt stays null on a rejection: the column is named for the
                 approval path, and filling it would make "approvedAt != null"
                 stop meaning approved. When a rejection happened is in
                 ApprovalAudit, which is the record that matters (ADR-0003).
              */
              { status: 'REJECTED', approvedByUserId: auth.userId, rejectionReason: trimmed };

    try {
        await prisma.$transaction(async (tx) => {
            /*
              Decisions on one membership take turns. A TEACHER + GUARDIAN request
              has two releasers, and each claim below moves a different row, so
              nothing else would stop the Principal and the homeroom teacher
              deciding at the same moment - each then derives the membership's
              status without the other's role, and two rejections strand it
              PENDING with nothing left for anyone to decide.

              This write is the lock: Postgres holds the row until commit, so a
              second decision waits here. A tenant-scoped updateMany rather than
              SELECT ... FOR UPDATE, because raw SQL would step outside the
              tenant extension.
            */
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

                if (role.role === 'GUARDIAN') {
                    const links = (membership.guardianLinks ?? []).filter(
                        (link) =>
                            link.status === 'PENDING' &&
                            scope.studentProfileIds.includes(link.studentProfileId)
                    );

                    for (const link of links) {
                        await tx.guardianStudent.updateMany({
                            where: { id: link.id, status: 'PENDING' },
                            data:
                                action === 'APPROVE'
                                    ? {
                                          status: 'ACTIVE',
                                          approvedByUserId: auth.userId,
                                          approvedAt: now,
                                      }
                                    : {
                                          status: 'REJECTED',
                                          approvedByUserId: auth.userId,
                                          endedAt: now,
                                      },
                        });

                        /*
                          The student is told. A guardian is never attached in
                          silence (ticket 05) - in-app only, because mailer.js
                          sends verification and password reset and nothing else.
                        */
                        if (action === 'APPROVE') {
                            await tx.notification.create({
                                data: {
                                    recipientMembershipId: link.studentProfile.membership.id,
                                    type: 'GUARDIAN_LINK_APPROVED',
                                    title: 'A guardian was linked to your account',
                                    body:
                                        `${membership.user.fullName} (${link.relationship}) can now ` +
                                        'see your progress at this school.',
                                },
                            });
                        }
                    }
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

            /*
              The membership follows its roles: ACTIVE as soon as one role is
              active, REJECTED only when nothing is left pending or active. A
              REJECTED row leaves the partial unique index, which is what lets the
              person apply again - capped by assertMembershipRetryAllowed.

              Read again here, never taken from the snapshot loadRequest() made
              before the lock: a decision that waited on it must see what the
              one before it committed.
            */
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
    return requestView(reloaded, releasableRoles(scopeAfter, reloaded));
}

const approveRequest = (auth, id, { classId } = {}) =>
    decideRequest(auth, id, { action: 'APPROVE', classId });

const rejectRequest = (auth, id, { reason } = {}) =>
    decideRequest(auth, id, { action: 'REJECT', reason });

/*
  Bulk approve, one transaction each rather than one for all: a homeroom teacher
  releasing thirty students should not lose twenty-nine of them because the
  thirtieth has a NISN that is already taken. Sequential, so every failure is
  attributable, and only expected errors are repeated back to the caller.
*/
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
    listRequests,
    getRequest,
    approveRequest,
    rejectRequest,
    bulkApprove,
};
