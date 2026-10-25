import { prisma } from './prisma.js';
import { badRequest, conflict, forbidden } from './errors.js';

// The shared approval service (ADR-0003).
//
// Three things need the same pending -> approved/rejected lifecycle: school
// registrations, memberships and their roles, and teaching assignments. They
// share this BEHAVIOUR while each keeping its own status column and real foreign
// keys - deliberately not a polymorphic ApprovalRequest table, which would trade
// referential integrity for a queue view we can assemble from typed queries.
//
// Everything that changes an approval state should route through here, because
// this is also the only place that writes ApprovalAudit.

const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 3;

// STUDENT is exclusive.
//
// A student who also held TEACHER would gain grading authority over their own
// class, which is the escalation the whole approval design exists to prevent.
// Every other combination is legitimate - TEACHER + GUARDIAN is the common case
// of a teacher whose own child attends the same school.
function assertRoleCombinationAllowed(roles) {
    const unique = [...new Set(roles)];

    if (unique.length === 0) {
        throw badRequest('At least one role must be requested');
    }
    if (unique.includes('STUDENT') && unique.length > 1) {
        throw badRequest(
            'The STUDENT role cannot be combined with any other role',
            { requested: unique }
        );
    }
    return unique;
}

// Only a pending thing can be decided. Deciding twice is a conflict, not an update.
function assertDecidable(currentStatus, subjectType) {
    if (currentStatus !== 'PENDING') {
        throw conflict(`This ${subjectType} has already been decided`, {
            currentStatus,
        });
    }
}

// A rejection without a reason is invisible to the person rejected - they cannot
// tell whether to correct something and re-apply, or stop asking.
//
// DEACTIVATE joins it for the same reason, one step larger: a school whose access
// is withdrawn has a Principal who will ask why, and "no reason given" is not an
// answer anybody can act on. Only the wording differs, because a school being
// switched off has not been rejected.
//
// END too (teaching-and-learning 10): a teacher taken off a class they still
// teach is owed the reason, the same way (owner, 2026-09-29).
function assertRejectionReason(action, reason) {
    if (action !== 'REJECT' && action !== 'DEACTIVATE' && action !== 'END') return;
    if (!reason || reason.trim().length < 3) {
        throw badRequest(action === 'REJECT' ? 'A rejection reason is required' : 'A reason is required');
    }
}

async function assertMembershipRetryAllowed({ userId, schoolId }) {
    const since = new Date(Date.now() - RETRY_WINDOW_MS);
    const attempts = await prisma.schoolMembership.count({
        where: { userId, schoolId, status: 'REJECTED', updatedAt: { gte: since } },
    });

    if (attempts >= MAX_ATTEMPTS_PER_WINDOW) {
        throw conflict(
            'Too many rejected join requests for this school recently. Try again tomorrow.',
            { attempts, windowHours: RETRY_WINDOW_MS / 3_600_000 }
        );
    }
}

// An admin application turned down three times at one Governing Body in a day waits
// for tomorrow, as a join request does at a School (governing-body ticket 04). A
// cancelled one, or a seat that ended, never counts.
async function assertSeatRetryAllowed({ userId, governingBodyId }) {
    const since = new Date(Date.now() - RETRY_WINDOW_MS);
    const attempts = await prisma.governingBodyAdmin.count({
        where: { userId, governingBodyId, status: 'REJECTED', updatedAt: { gte: since } },
    });

    if (attempts >= MAX_ATTEMPTS_PER_WINDOW) {
        throw conflict(
            'Too many rejected admin applications for this governing body recently. Try again tomorrow.',
            { attempts, windowHours: RETRY_WINDOW_MS / 3_600_000 }
        );
    }
}

// Why a Principal application closes on its own when another applicant for its School is
// approved (governing-body ticket 06, K8). Named here because the cap below leaves it out.
const SCHOOL_HAS_PRINCIPAL = 'The school has a Principal now';

// A Principal application turned down three times at one School in a day waits for
// tomorrow, as a join request does (governing-body ticket 06). Only an admin's own
// rejection counts: one closed because another applicant was approved lost a race, and
// was not turned down for itself. A cancelled one never counts.
async function assertPrincipalApplicationRetryAllowed({ userId, schoolId }) {
    const since = new Date(Date.now() - RETRY_WINDOW_MS);
    const attempts = await prisma.principalApplication.count({
        where: {
            userId,
            schoolId,
            status: 'REJECTED',
            rejectionReason: { not: SCHOOL_HAS_PRINCIPAL },
            decidedAt: { gte: since },
        },
    });

    if (attempts >= MAX_ATTEMPTS_PER_WINDOW) {
        throw conflict(
            'Too many rejected Principal applications for this school recently. Try again tomorrow.',
            { attempts, windowHours: RETRY_WINDOW_MS / 3_600_000 }
        );
    }
}

// An Affiliation Request turned down three times by one Governing Body in a day waits for
// tomorrow, as a join request does (governing-body ticket 08). A cancelled one never
// counts. It is the School's, so the count is the School's at that body.
async function assertAffiliationRetryAllowed({ schoolId, governingBodyId }) {
    const since = new Date(Date.now() - RETRY_WINDOW_MS);
    const attempts = await prisma.affiliationRequest.count({
        where: { schoolId, governingBodyId, status: 'REJECTED', decidedAt: { gte: since } },
    });

    if (attempts >= MAX_ATTEMPTS_PER_WINDOW) {
        throw conflict(
            'Too many rejected requests to join this governing body recently. Try again tomorrow.',
            { attempts, windowHours: RETRY_WINDOW_MS / 3_600_000 }
        );
    }
}

async function assertClassSubjectRetryAllowed({
    teacherMembershipId,
    classId,
    subjectId,
    semesterId,
}) {
    const since = new Date(Date.now() - RETRY_WINDOW_MS);
    const attempts = await prisma.classSubject.count({
        where: {
            teacherMembershipId,
            classId,
            subjectId,
            semesterId,
            status: 'REJECTED',
            updatedAt: { gte: since },
        },
    });

    if (attempts >= MAX_ATTEMPTS_PER_WINDOW) {
        throw conflict(
            'Too many rejected requests for this teaching slot recently. Try again tomorrow.',
            { attempts }
        );
    }
}

// The durable ceiling on school registrations.
//
// registrationLimiter in ./rateLimit.js damps the traffic, but its memory store
// is per-process and forgets on every restart - `npm run dev` runs under
// --watch, so that window resets whenever a file is saved. A rule a human
// reviewer relies on has to outlive the process.
async function assertSchoolRegistrationAllowed({ applicantUserId }) {
    const since = new Date(Date.now() - RETRY_WINDOW_MS);
    const recent = await prisma.schoolRegistration.count({
        where: { applicantUserId, createdAt: { gte: since } },
    });

    if (recent >= MAX_ATTEMPTS_PER_WINDOW) {
        throw conflict(
            'Too many school registration submissions today. Try again tomorrow.',
            { attempts: recent, windowHours: RETRY_WINDOW_MS / 3_600_000 }
        );
    }
}

// The same durable ceiling on Governing Body registrations (governing-body ticket 03),
// counted on their own table: a founder's school and yayasan are two budgets.
async function assertGoverningBodyRegistrationAllowed({ applicantUserId }) {
    const since = new Date(Date.now() - RETRY_WINDOW_MS);
    const recent = await prisma.governingBodyRegistration.count({
        where: { applicantUserId, createdAt: { gte: since } },
    });

    if (recent >= MAX_ATTEMPTS_PER_WINDOW) {
        throw conflict(
            'Too many governing body registration submissions today. Try again tomorrow.',
            { attempts: recent, windowHours: RETRY_WINDOW_MS / 3_600_000 }
        );
    }
}

// Append-only. Never updated, never deleted - it is the record of who decided
// what, and a mutable audit log is not an audit log.
//
// `schoolId` is null for school-registration decisions, which happen before any
// school exists; those callers run inside runUnscoped().
async function recordAudit({
    schoolId = null,
    subjectType,
    subjectId,
    action,
    actorUserId,
    reason = null,
    client = prisma,
}) {
    return client.approvalAudit.create({
        data: { schoolId, subjectType, subjectId, action, actorUserId, reason },
    });
}

// Guard for the deadline on new teaching assignments. The principal override is
// a separate, audited path - not a bypass callers may take on their own.
function assertWithinRegistrationDeadline(semester, { isOverride = false } = {}) {
    if (isOverride) return;

    const deadline = semester?.classSubjectRegistrationDeadline;
    if (deadline && new Date() > new Date(deadline)) {
        throw forbidden(
            'The teaching assignment registration deadline for this semester has passed. ' +
                'Ask the principal to add it directly.'
        );
    }
}

export {
    RETRY_WINDOW_MS,
    MAX_ATTEMPTS_PER_WINDOW,
    assertRoleCombinationAllowed,
    assertDecidable,
    assertRejectionReason,
    assertMembershipRetryAllowed,
    assertSeatRetryAllowed,
    SCHOOL_HAS_PRINCIPAL,
    assertPrincipalApplicationRetryAllowed,
    assertAffiliationRetryAllowed,
    assertClassSubjectRetryAllowed,
    assertSchoolRegistrationAllowed,
    assertGoverningBodyRegistrationAllowed,
    assertWithinRegistrationDeadline,
    recordAudit,
};
