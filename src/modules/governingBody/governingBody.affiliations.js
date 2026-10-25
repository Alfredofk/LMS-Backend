import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
import {
    assertAffiliationRetryAllowed,
    assertDecidable,
    assertRejectionReason,
    recordAudit,
} from '../../shared/approval.js';
import { isPrincipal } from '../../shared/guards.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { resolveGoverningBody } from './governingBody.service.js';

const log = createLogger('GoverningBody');

// A School's place under Governing Bodies (governing-body ticket 08, the spec's K12): an
// independent School asking to join one, and the history of its time under each.
//
// Owner's decisions (2026-10-18; the plan, 2026-10-26, through the picker):
// - An Affiliation Request, named apart from a Join Request, which asks for a membership.
//   The Principal of an independent School sends it with the body's code, and may cancel
//   it. It is the School's: the next Principal reads and cancels it too.
// - Any admin of the body approves, or rejects with a reason the Principal reads. One
//   waiting per School; three rejections a day by one body (approval.js), a cancel never
//   counted. A School in a body already cannot ask.
// - Approval claims the School while it is still independent and running, sets its
//   governingBodyId and opens its SchoolAffiliation, audited APPROVE on the request and
//   JOIN on the School. From then the body appoints its Principal (K10), and the Platform
//   Admin only while the body is deactivated (ticket 06b).
// - The history is a table (owner's pick, against the proposal): one SchoolAffiliation per
//   time under a body, opened by its creation (ticket 05) or its joining, closed by its
//   release (governingBody.powers.js). The Platform Admin reads it per School.

const SUBJECT = 'AffiliationRequest';
const SCHOOL_SUBJECT = 'School';
const MISSING = 'Request to join not found';
const ALREADY_GOVERNED = 'This school already belongs to a governing body';
const ONE_WAITING = 'This school already has a request to join a governing body waiting';

const requestInclude = {
    school: { select: { id: true, name: true, npsn: true, schoolType: true, city: true } },
    governingBody: { select: { id: true, name: true, kind: true } },
    requestedBy: { select: { fullName: true } },
    decidedBy: { select: { id: true, fullName: true } },
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// The School's own: which body it asked, and what came of it.
const schoolSideView = (request) => ({
    id: request.id,
    status: request.status,
    governingBody: { name: request.governingBody.name, kind: request.governingBody.kind },
    requestedBy: { fullName: request.requestedBy.fullName },
    requestedAt: request.createdAt,
    decidedAt: request.decidedAt,
    rejectionReason: request.rejectionReason,
});

// The body's admins': which School asks, and who decided.
const bodySideView = (request) => ({
    id: request.id,
    status: request.status,
    school: request.school,
    requestedBy: { fullName: request.requestedBy.fullName },
    requestedAt: request.createdAt,
    decidedAt: request.decidedAt,
    decidedBy: request.decidedBy,
    rejectionReason: request.rejectionReason,
});

const affiliationView = (row) => ({
    id: row.id,
    governingBody: row.governingBody,
    began: row.began,
    startedAt: row.startedAt,
    startedBy: row.startedBy ? { fullName: row.startedBy.fullName } : null,
    endedAt: row.endedAt,
    endedBy: row.endedBy ? { fullName: row.endedBy.fullName } : null,
    endReason: row.endReason,
});

// ---------------------------------------------------------------------------
// The School's Principal
// ---------------------------------------------------------------------------

// The Principal checked against the database, as rotateSchoolCode does: a role withdrawn
// minutes ago must not still work.
async function assertPrincipal(auth) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden('Only the Principal can do this');
}

// POST /api/school/affiliation-requests: the body's code. An unknown or deactivated code
// is 404, as at the lookup; a School in a body already, a second request waiting, and the
// fourth rejection of a day, 409.
async function requestAffiliation(auth, { code }) {
    await assertPrincipal(auth);
    const school = await prisma.school.findUnique({
        where: { id: auth.schoolId },
        select: { id: true, name: true, governingBodyId: true },
    });
    if (school.governingBodyId) throw conflict(ALREADY_GOVERNED);

    const body = await resolveGoverningBody(code);
    const waiting = await prisma.affiliationRequest.findFirst({
        where: { schoolId: school.id, status: 'PENDING' },
        select: { id: true },
    });
    if (waiting) throw conflict(ONE_WAITING);
    await assertAffiliationRetryAllowed({ schoolId: school.id, governingBodyId: body.id });

    try {
        const created = await runUnscoped('a principal asking to join a governing body', async () =>
            await prisma.$transaction(async (tx) => {
                const request = await tx.affiliationRequest.create({
                    data: { schoolId: school.id, governingBodyId: body.id, requestedByUserId: auth.userId },
                    include: requestInclude,
                });
                await recordAudit({
                    schoolId: school.id,
                    subjectType: SUBJECT,
                    subjectId: request.id,
                    action: 'SUBMIT',
                    actorUserId: auth.userId,
                    client: tx,
                });
                return request;
            })
        );

        log.info(`${school.name} asked to join ${body.name}`);
        return schoolSideView(created);
    } catch (error) {
        // Two requests racing past the check above: the partial index is the rule.
        if (error?.code === 'P2002') throw conflict(ONE_WAITING);
        throw error;
    }
}

// GET /api/school/affiliation-requests: the School's, newest first.
async function listSchoolRequests(auth) {
    await assertPrincipal(auth);
    const requests = await prisma.affiliationRequest.findMany({
        where: { schoolId: auth.schoolId },
        include: requestInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return requests.map(schoolSideView);
}

// POST /api/school/affiliation-requests/:id/cancel: one still waiting, claimed, so an
// admin deciding at the same moment and the Principal cancelling cannot both win.
async function cancelRequest(auth, id) {
    await assertPrincipal(auth);
    const request = await prisma.affiliationRequest.findFirst({
        where: { id, schoolId: auth.schoolId, status: 'PENDING' },
        include: requestInclude,
    });
    if (!request) throw notFound('No request of this school to join a governing body is waiting under that id');

    const now = new Date();
    await runUnscoped('a principal cancelling a request to join a governing body', async () =>
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.affiliationRequest.updateMany({
                where: { id: request.id, status: 'PENDING' },
                data: { status: 'CANCELLED', decidedAt: now },
            });
            if (claimed.count === 0) throw conflict('This request to join has already been decided');

            await recordAudit({
                schoolId: request.schoolId,
                subjectType: SUBJECT,
                subjectId: request.id,
                action: 'CANCEL',
                actorUserId: auth.userId,
                client: tx,
            });
        })
    );

    log.info(`${request.school.name} cancelled its request to join ${request.governingBody.name}`);
    return schoolSideView({ ...request, status: 'CANCELLED', decidedAt: now });
}

// ---------------------------------------------------------------------------
// The body's admins
// ---------------------------------------------------------------------------

// One request to this body. Another body's, or none, is one 404.
async function loadOwnRequest(auth, id) {
    const request = await prisma.affiliationRequest.findFirst({
        where: { id, governingBodyId: auth.governingBodyId },
        include: requestInclude,
    });
    if (!request) throw notFound(MISSING);
    return request;
}

// GET /api/governing-body/affiliation-requests, for any admin: the waiting ones by
// default, oldest first, as a queue is worked.
async function listBodyRequests(auth, { status }) {
    const requests = await prisma.affiliationRequest.findMany({
        where: { governingBodyId: auth.governingBodyId, ...(status === 'ALL' ? {} : { status }) },
        include: requestInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return requests.map(bodySideView);
}

// POST /api/governing-body/affiliation-requests/:id/approve, for any admin. In one
// transaction: the claim out of PENDING, the School claimed while still independent and
// running (409 otherwise), its affiliation opened, APPROVE and JOIN audited.
async function approveRequest(auth, id) {
    const request = await loadOwnRequest(auth, id);
    assertDecidable(request.status, 'request to join');
    const now = new Date();

    await runUnscoped('a governing body admin approving a school joining it', async () =>
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.affiliationRequest.updateMany({
                where: { id: request.id, status: 'PENDING' },
                data: { status: 'APPROVED', decidedByUserId: auth.userId, decidedAt: now },
            });
            if (claimed.count === 0) throw conflict('This request to join has already been decided');

            const joined = await tx.school.updateMany({
                where: { id: request.schoolId, governingBodyId: null, deactivatedAt: null },
                data: { governingBodyId: auth.governingBodyId },
            });
            if (joined.count === 0) {
                throw conflict('This school has joined a governing body, or been deactivated, meanwhile');
            }

            await tx.schoolAffiliation.create({
                data: {
                    schoolId: request.schoolId,
                    governingBodyId: auth.governingBodyId,
                    began: 'JOINED',
                    startedAt: now,
                    startedByUserId: auth.userId,
                    affiliationRequestId: request.id,
                },
            });
            await recordAudit({
                schoolId: request.schoolId,
                subjectType: SUBJECT,
                subjectId: request.id,
                action: 'APPROVE',
                actorUserId: auth.userId,
                client: tx,
            });
            await recordAudit({
                schoolId: request.schoolId,
                subjectType: SCHOOL_SUBJECT,
                subjectId: request.schoolId,
                action: 'JOIN',
                actorUserId: auth.userId,
                client: tx,
            });
        })
    );

    log.info(`${request.school.name} joined ${request.governingBody.name}`);
    return bodySideView(await loadOwnRequest(auth, request.id));
}

// POST /api/governing-body/affiliation-requests/:id/reject, for any admin, with a reason
// the Principal reads. It counts toward the School's three a day at this body.
async function rejectRequest(auth, id, { reason } = {}) {
    assertRejectionReason('REJECT', reason);
    const trimmed = reason.trim();
    const request = await loadOwnRequest(auth, id);
    assertDecidable(request.status, 'request to join');
    const now = new Date();

    await runUnscoped('a governing body admin rejecting a school joining it', async () =>
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.affiliationRequest.updateMany({
                where: { id: request.id, status: 'PENDING' },
                data: { status: 'REJECTED', decidedByUserId: auth.userId, decidedAt: now, rejectionReason: trimmed },
            });
            if (claimed.count === 0) throw conflict('This request to join has already been decided');

            await recordAudit({
                schoolId: request.schoolId,
                subjectType: SUBJECT,
                subjectId: request.id,
                action: 'REJECT',
                actorUserId: auth.userId,
                reason: trimmed,
                client: tx,
            });
        })
    );

    log.info(`${request.school.name}'s request to join ${request.governingBody.name} was rejected`);
    return bodySideView(await loadOwnRequest(auth, request.id));
}

// ---------------------------------------------------------------------------
// The history
// ---------------------------------------------------------------------------

// GET /api/admin/schools/:id/affiliations, for the Platform Admin: every body the School
// has been under, the latest first, each with how it began and how it ended.
async function affiliationsOf(schoolId) {
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { id: true } });
    if (!school) throw notFound('School not found');

    const rows = await prisma.schoolAffiliation.findMany({
        where: { schoolId: school.id },
        include: {
            governingBody: { select: { id: true, name: true, kind: true } },
            startedBy: { select: { fullName: true } },
            endedBy: { select: { fullName: true } },
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(affiliationView);
}

export {
    requestAffiliation,
    listSchoolRequests,
    cancelRequest,
    listBodyRequests,
    approveRequest,
    rejectRequest,
    affiliationsOf,
};
