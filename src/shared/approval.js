'use strict';

const { prisma } = require('./prisma');
const { badRequest, conflict, forbidden } = require('./errors');

/**
 * The shared approval service (ADR-0003).
 *
 * Three things need the same pending -> approved/rejected lifecycle: school
 * registrations, memberships and their roles, and teaching assignments. They
 * share this BEHAVIOUR while each keeping its own status column and real foreign
 * keys - deliberately not a polymorphic ApprovalRequest table, which would trade
 * referential integrity for a queue view we can assemble from typed queries.
 *
 * Everything that changes an approval state should route through here, because
 * this is also the only place that writes ApprovalAudit.
 */

const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 3;

/**
 * STUDENT is exclusive.
 *
 * A student who also held TEACHER would gain grading authority over their own
 * class, which is the escalation the whole approval design exists to prevent.
 * Every other combination is legitimate - TEACHER + GUARDIAN is the common case
 * of a teacher whose own child attends the same school.
 */
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

/** Only a pending thing can be decided. Deciding twice is a conflict, not an update. */
function assertDecidable(currentStatus, subjectType) {
    if (currentStatus !== 'PENDING') {
        throw conflict(`This ${subjectType} has already been decided`, {
            currentStatus,
        });
    }
}

/**
 * A rejection without a reason is invisible to the person rejected - they cannot
 * tell whether to correct something and re-apply, or stop asking.
 */
function assertRejectionReason(action, reason) {
    if (action !== 'REJECT') return;
    if (!reason || reason.trim().length < 3) {
        throw badRequest('A rejection reason is required');
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

/**
 * Append-only. Never updated, never deleted - it is the record of who decided
 * what, and a mutable audit log is not an audit log.
 *
 * `schoolId` is null for school-registration decisions, which happen before any
 * school exists; those callers run inside runUnscoped().
 */
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

/**
 * Guard for the deadline on new teaching assignments. The principal override is
 * a separate, audited path - not a bypass callers may take on their own.
 */
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

module.exports = {
    RETRY_WINDOW_MS,
    MAX_ATTEMPTS_PER_WINDOW,
    assertRoleCombinationAllowed,
    assertDecidable,
    assertRejectionReason,
    assertMembershipRetryAllowed,
    assertClassSubjectRetryAllowed,
    assertWithinRegistrationDeadline,
    recordAudit,
};
