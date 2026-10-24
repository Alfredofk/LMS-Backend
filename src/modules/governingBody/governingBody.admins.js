import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
import {
    assertDecidable,
    assertRejectionReason,
    assertSeatRetryAllowed,
    recordAudit,
} from '../../shared/approval.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { assertEligibleApplicant } from '../membership/membership.service.js';
import { isStudentAnywhere } from '../membership/membership.eligibility.js';
import { loadGoverningBody, publicBodyView, resolveGoverningBody } from './governingBody.service.js';

const log = createLogger('GoverningBody');

// A Governing Body's admins (governing-body ticket 04, the spec's K6): several, each of
// whom asked through the Governing Body Code, and the earliest of them deciding who
// else joins. A seat (GoverningBodyAdmin) lives as a membership does: PENDING, then
// ACTIVE or REJECTED, or CANCELLED by its applicant; an ACTIVE seat ends LEFT.
//
// Owner's decisions (2026-10-18; the build plan, 2026-10-24):
// - An application is the code alone. One waiting or held seat per person per body; the
//   applicant may cancel; three rejections a day at one body at most (approval.js). A
//   Student may not apply (ticket 01's rule), and a live seat refuses a STUDENT request
//   anywhere (membership.eligibility.js).
// - The senior admin is the sitting admin approved earliest; a tie goes to the earlier
//   request, then the id. When they end, the next is senior, with no step.
// - Only the senior approves or rejects an application, and removes another admin with
//   a reason. Every other admin gets 403: they read the applications, and decide none.
// - Every admin sees the sitting admins and the applications, each by name and email,
//   as a Principal sees a join request.
// - An admin leaves unless they are the last. Account deletion is refused for the last
//   admin of a live body (ADR-0007), and ends every other seat.
// - The Platform Admin is the brake (owner, 2026-10-24): it removes any admin with a
//   reason, the senior or the last included, and decides the applications of a body
//   left with no admin, only until someone sits (option A: never by an email typed in).
// - Audited against `GoverningBodyAdmin`, `schoolId` null.
//
// The seat and the body are above tenancy. ApprovalAudit is tenant-owned, so every
// write that records one runs unscoped.

const SEAT_SUBJECT = 'GoverningBodyAdmin';

const LIVE = ['PENDING', 'ACTIVE'];

// A seat that holds its body now. An ended seat keeps status LEFT, so endedAt is
// belt and braces, as requireGoverningBodyAdmin reads it.
const SITTING = { status: 'ACTIVE', endedAt: null };

// Seniority (K6; the tie, owner 2026-10-24): approved earliest, then asked earliest,
// then the id, so two approvals in one instant still have one senior.
const SENIORITY = [{ approvedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];

const LAST_ADMIN = 'A governing body cannot be left without an admin';
const ENDED_BY_DELETION = 'Account deleted';
const ENDED_AT_DEACTIVATED_BODY = 'Account deleted while the governing body was deactivated';

const personSelect = { select: { id: true, fullName: true, email: true } };
const bodySelect = { select: { name: true, kind: true } };

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const personOf = (user) => ({ id: user.id, fullName: user.fullName, email: user.email });

// The applicant's own seat: where they asked, what came of it, and why.
const ownSeatView = (seat) => ({
    id: seat.id,
    status: seat.status,
    requestedAt: seat.createdAt,
    approvedAt: seat.approvedAt,
    endedAt: seat.endedAt,
    rejectionReason: seat.rejectionReason,
    endReason: seat.endReason,
    governingBody: publicBodyView(seat.governingBody),
});

// A sitting admin as their colleagues see them, the senior first. viewerId is the
// caller's user, null for a Platform Admin, who sits nowhere.
const sittingView = (viewerId) => (seat, index) => ({
    id: seat.id,
    user: personOf(seat.user),
    approvedAt: seat.approvedAt,
    senior: index === 0,
    you: seat.userId === viewerId,
});

// An application as every admin sees it (K2, owner 2026-10-24): the name and the
// email, nothing the applicant did not give the platform.
const applicationView = (seat) => ({
    id: seat.id,
    status: seat.status,
    user: personOf(seat.user),
    requestedAt: seat.createdAt,
    approvedAt: seat.approvedAt,
    rejectionReason: seat.rejectionReason,
});

// ---------------------------------------------------------------------------
// Seniority and the lock
// ---------------------------------------------------------------------------

// One change of a body's seats at a time. Its row is the lock, as lockSchool's is for
// a School's Principal: an approval, a rejection, a removal, a leave and an account's
// deletion each take it first, then read the senior and the admins again under it.
// Without it two admins leaving at once would each still count the other, and leave
// the body with none. An updateMany rather than SELECT ... FOR UPDATE: raw SQL is the
// owner's to allow (CLAUDE.md).
const lockGoverningBody = (tx, governingBodyId, now) =>
    tx.governingBody.updateMany({ where: { id: governingBodyId }, data: { updatedAt: now } });

// The senior admin (K6): nobody is made senior, the order of approval says who is.
const seniorSeatOf = (client, governingBodyId) =>
    client.governingBodyAdmin.findFirst({
        where: { governingBodyId, ...SITTING },
        orderBy: SENIORITY,
        select: { id: true, userId: true },
    });

// 403: every admin reads the applications and their colleagues, and only the senior
// decides or removes. Asked once before the work and again under the lock, so a
// senior who left a moment ago decides nothing.
async function assertSenior(client, auth) {
    const senior = await seniorSeatOf(client, auth.governingBodyId);
    if (senior?.userId !== auth.userId) throw forbidden('Only the senior admin can do this');
}

// ---------------------------------------------------------------------------
// The applicant
// ---------------------------------------------------------------------------

// POST /api/governing-body-applications/admins: asking to be an admin through the code.
// One waiting or held seat per person per body - the partial index
// GoverningBodyAdmin_one_live_per_user_per_body is the ceiling, this check the sentence -
// and three rejections a day at most. A Student is refused, as at the lookup.
async function applyAsAdmin(userId, { code }) {
    await assertEligibleApplicant(userId);
    const body = await resolveGoverningBody(code);
    if (await isStudentAnywhere(userId)) {
        throw conflict('A student belongs to one school only, so cannot be an admin of a governing body');
    }

    const live = await prisma.governingBodyAdmin.findFirst({
        where: { userId, governingBodyId: body.id, status: { in: LIVE } },
        select: { status: true },
    });
    if (live) {
        throw conflict(
            live.status === 'PENDING'
                ? 'You already have an admin application waiting at this governing body'
                : 'You are already an admin of this governing body'
        );
    }
    await assertSeatRetryAllowed({ userId, governingBodyId: body.id });

    try {
        const seat = await runUnscoped('an admin application to a governing body, above any school', async () =>
            await prisma.$transaction(async (tx) => {
                const created = await tx.governingBodyAdmin.create({
                    data: { governingBodyId: body.id, userId },
                    include: { governingBody: bodySelect },
                });

                await recordAudit({
                    subjectType: SEAT_SUBJECT,
                    subjectId: created.id,
                    action: 'SUBMIT',
                    actorUserId: userId,
                    client: tx,
                });

                return created;
            })
        );

        log.info(`Admin application at ${body.name}`);
        return ownSeatView(seat);
    } catch (error) {
        // Two applications racing past the check above: the index is the rule.
        if (error?.code === 'P2002') {
            throw conflict('You already have an admin application waiting at this governing body');
        }
        throw error;
    }
}

// GET /api/governing-body-applications/mine: every seat of theirs, newest first, with
// its outcome - a rejection's reason, or why a seat ended.
async function listOwnSeats(userId) {
    const seats = await prisma.governingBodyAdmin.findMany({
        where: { userId },
        include: { governingBody: bodySelect },
        orderBy: { createdAt: 'desc' },
    });
    return seats.map(ownSeatView);
}

// The applicant taking a waiting application back: CANCELLED, never counted against the
// cap, free to ask again. Claimed, so the senior deciding at the same moment and the
// applicant cancelling cannot both win (the join request's rule). Allowed while the
// body is deactivated too: it asks nothing of the body.
async function cancelApplication(userId, seatId) {
    const seat = await prisma.governingBodyAdmin.findFirst({
        where: { id: seatId, userId, status: 'PENDING' },
        include: { governingBody: bodySelect },
    });
    if (!seat) throw notFound('No admin application of yours is waiting under that id');

    const now = new Date();
    await runUnscoped('an applicant cancelling an admin application', async () =>
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.governingBodyAdmin.updateMany({
                where: { id: seat.id, status: 'PENDING' },
                data: { status: 'CANCELLED', endedAt: now },
            });
            if (claimed.count === 0) throw conflict('This admin application has already been decided');

            await recordAudit({
                subjectType: SEAT_SUBJECT,
                subjectId: seat.id,
                action: 'CANCEL',
                actorUserId: userId,
                client: tx,
            });
        })
    );

    log.info(`Admin application cancelled at ${seat.governingBody.name}`);
    return ownSeatView({ ...seat, status: 'CANCELLED', endedAt: now });
}

// ---------------------------------------------------------------------------
// The admins
// ---------------------------------------------------------------------------

// A body's sitting admins, the senior first, and its applications waiting, oldest
// first.
const seatsOf = (governingBodyId) =>
    Promise.all([
        prisma.governingBodyAdmin.findMany({
            where: { governingBodyId, ...SITTING },
            include: { user: personSelect },
            orderBy: SENIORITY,
        }),
        prisma.governingBodyAdmin.findMany({
            where: { governingBodyId, status: 'PENDING' },
            include: { user: personSelect },
            orderBy: { createdAt: 'asc' },
        }),
    ]);

// GET /api/governing-body/admins, for every admin. youAreSenior says whether the
// caller may decide the applications.
async function listAdmins(auth) {
    const [sitting, waiting] = await seatsOf(auth.governingBodyId);
    const admins = sitting.map(sittingView(auth.userId));
    return {
        admins,
        applications: waiting.map(applicationView),
        youAreSenior: admins[0]?.you === true,
    };
}

// One seat of this body; another body's, or none, is one 404.
async function loadSeat(governingBodyId, seatId, where = {}) {
    const seat = await prisma.governingBodyAdmin.findFirst({
        where: { id: seatId, governingBodyId, ...where },
        include: { user: { select: { id: true, fullName: true, email: true, deletedAt: true } } },
    });
    if (!seat) throw notFound(where.status ? 'Admin not found' : 'Admin application not found');
    return seat;
}

// Approve or reject. mayDecide is who may: the senior (decideApplication), or a
// Platform Admin while the body has no admin (decideWithoutAdmin). It is asked once
// before the work and again in one transaction under the body's lock, with the seat
// claimed out of PENDING - two clicks decide once - and the audit row. An approval
// needs the applicant's account still live and still no Student, as a registration's
// approval checks again.
async function decide({ governingBodyId, seatId, action, reason, actorUserId, mayDecide, decider }) {
    let trimmed = null;
    if (action === 'REJECT') {
        assertRejectionReason('REJECT', reason);
        trimmed = reason.trim();
    }

    const seat = await loadSeat(governingBodyId, seatId);
    await mayDecide(prisma);
    assertDecidable(seat.status, 'admin application');

    if (action === 'APPROVE') {
        if (seat.user.deletedAt) throw conflict('The applicant account no longer exists');
        if (await isStudentAnywhere(seat.userId)) {
            throw conflict(
                'The applicant is a student at a school, or has asked to be one, and a student belongs to ' +
                    'one school only'
            );
        }
    }

    const now = new Date();
    const data =
        action === 'APPROVE'
            ? { status: 'ACTIVE', approvedAt: now }
            : { status: 'REJECTED', rejectionReason: trimmed };

    await runUnscoped(`${decider} deciding an admin application`, async () =>
        await prisma.$transaction(async (tx) => {
            await lockGoverningBody(tx, governingBodyId, now);
            await mayDecide(tx);

            const claimed = await tx.governingBodyAdmin.updateMany({
                where: { id: seat.id, status: 'PENDING' },
                data,
            });
            if (claimed.count === 0) throw conflict('This admin application has already been decided');

            await recordAudit({
                subjectType: SEAT_SUBJECT,
                subjectId: seat.id,
                action,
                actorUserId,
                reason: trimmed,
                client: tx,
            });
        })
    );

    log.info(`Admin application ${action === 'APPROVE' ? 'approved' : 'rejected'} by ${decider}`);
    return applicationView(await loadSeat(governingBodyId, seat.id));
}

// The senior's decision, through the body's own routes.
const decideApplication = (auth, seatId, { action, reason }) =>
    decide({
        governingBodyId: auth.governingBodyId,
        seatId,
        action,
        reason,
        actorUserId: auth.userId,
        mayDecide: (client) => assertSenior(client, auth),
        decider: 'the senior admin',
    });

const approveApplication = (auth, seatId) => decideApplication(auth, seatId, { action: 'APPROVE' });

const rejectApplication = (auth, seatId, { reason } = {}) =>
    decideApplication(auth, seatId, { action: 'REJECT', reason });

// A sitting admin taken off the body, with a reason the one removed reads on their own
// seats. The seat ends LEFT: requireGoverningBodyAdmin refuses them at once, and their
// next refresh opens no Place, as a removed Teacher's does. mayRemove is who may - the
// senior (removeAdmin), or a Platform Admin (removeAsPlatformAdmin) - asked once before
// the work and again under the body's lock, as decide() asks.
async function removeSeat({ governingBodyId, seatId, reason, actorUserId, mayRemove, remover }) {
    const seat = await loadSeat(governingBodyId, seatId, SITTING);
    await mayRemove(prisma, seat);

    const trimmed = reason.trim();
    const now = new Date();

    await runUnscoped(`${remover} removing an admin`, async () =>
        await prisma.$transaction(async (tx) => {
            await lockGoverningBody(tx, governingBodyId, now);
            await mayRemove(tx, seat);

            const claimed = await tx.governingBodyAdmin.updateMany({
                where: { id: seat.id, ...SITTING },
                data: { status: 'LEFT', endedAt: now, endReason: trimmed },
            });
            if (claimed.count === 0) throw conflict('This admin has already left');

            await recordAudit({
                subjectType: SEAT_SUBJECT,
                subjectId: seat.id,
                action: 'REMOVE',
                actorUserId,
                reason: trimmed,
                client: tx,
            });
        })
    );

    log.info(`An admin was removed by ${remover}`);
    return { id: seat.id, status: 'LEFT', endReason: trimmed };
}

// The senior's removal (K6). Not oneself - the senior leaves instead - so their removal
// never leaves the body empty.
const removeAdmin = (auth, seatId, { reason }) =>
    removeSeat({
        governingBodyId: auth.governingBodyId,
        seatId,
        reason,
        actorUserId: auth.userId,
        mayRemove: async (client, seat) => {
            await assertSenior(client, auth);
            if (seat.userId === auth.userId) {
                throw conflict('To step down yourself, leave the governing body instead');
            }
        },
        remover: 'the senior admin',
    });

// Any admin leaves, unless they are the last (K6): a body without an admin decides
// nothing, and nobody could become one. Counted under the lock, so two admins leaving
// together cannot both pass. When the senior leaves, the next by approval is senior
// from that moment.
async function leaveGoverningBody(auth) {
    const body = await loadGoverningBody(auth.governingBodyId);
    const now = new Date();

    const seatId = await runUnscoped('an admin leaving a governing body', async () =>
        await prisma.$transaction(async (tx) => {
            await lockGoverningBody(tx, body.id, now);

            const sitting = await tx.governingBodyAdmin.findMany({
                where: { governingBodyId: body.id, ...SITTING },
                select: { id: true, userId: true },
            });
            const own = sitting.find((seat) => seat.userId === auth.userId);
            if (!own) throw notFound('Admin not found');
            if (sitting.length === 1) throw conflict(LAST_ADMIN);

            const claimed = await tx.governingBodyAdmin.updateMany({
                where: { id: own.id, ...SITTING },
                data: { status: 'LEFT', endedAt: now },
            });
            if (claimed.count === 0) throw conflict('You have already left this governing body');

            await recordAudit({
                subjectType: SEAT_SUBJECT,
                subjectId: own.id,
                action: 'LEAVE',
                actorUserId: auth.userId,
                client: tx,
            });

            return own.id;
        })
    );

    log.info(`An admin left ${body.name}`);
    return { id: seatId, status: 'LEFT' };
}

// ---------------------------------------------------------------------------
// The Platform Admin's brake (owner, 2026-10-24)
// ---------------------------------------------------------------------------
//
// Two ways a body can stall, and the Platform Admin's answer to each:
// - Its senior vanished without leaving. Nobody else decides an application or removes
//   anyone, so the body is stuck though others sit. The Platform Admin removes an admin
//   with a reason, the senior or the last one included (the spec's K10': it is the
//   emergency brake); seniority is counted again at once.
// - It has no admin left: its last deleted their account while it was deactivated, or
//   the Platform Admin removed them. The Platform Admin then decides its admin
//   applications in the senior's place, and only then: once someone sits, they are
//   senior and decide.
// Nobody is made an admin by having their email typed in (the spec's invariant 6, as
// ADR-0008 appoints only a teacher already at the School): the person applies with
// the code, which the Platform Admin reads on the body's admins.

// 409 while the body has a sitting admin: its senior decides. Read again under the
// lock, so the Platform Admin and a senior just approved never both decide.
async function assertNoSittingAdmin(client, governingBodyId) {
    const sitting = await client.governingBodyAdmin.count({ where: { governingBodyId, ...SITTING } });
    if (sitting > 0) throw conflict('This governing body has an admin; its senior admin decides its applications');
}

// GET /api/admin/governing-bodies/:id/admins: the body with its code - to hand to
// whoever should apply - its sitting admins and its applications waiting.
async function listAdminsOf(governingBodyId) {
    const body = await loadGoverningBody(governingBodyId);
    const [sitting, waiting] = await seatsOf(body.id);
    return {
        governingBody: { id: body.id, name: body.name, code: body.code, deactivatedAt: body.deactivatedAt },
        admins: sitting.map(sittingView(null)),
        applications: waiting.map(applicationView),
    };
}

// The Platform Admin's decision on a body with no admin. Allowed while it is
// deactivated too, as appointPrincipal is at a School: one restored without an admin
// needs it before anyone can run it.
async function decideWithoutAdmin(adminUserId, governingBodyId, seatId, { action, reason }) {
    await loadGoverningBody(governingBodyId);
    return decide({
        governingBodyId,
        seatId,
        action,
        reason,
        actorUserId: adminUserId,
        mayDecide: (client) => assertNoSittingAdmin(client, governingBodyId),
        decider: 'a platform admin',
    });
}

// The Platform Admin removing any sitting admin of a body, with a reason: nothing but
// requirePlatformAdmin stands in the way. Removing the last empties the body, whose
// applications the Platform Admin then decides (decideWithoutAdmin).
async function removeAsPlatformAdmin(adminUserId, governingBodyId, seatId, { reason }) {
    await loadGoverningBody(governingBodyId);
    return removeSeat({
        governingBodyId,
        seatId,
        reason,
        actorUserId: adminUserId,
        mayRemove: async () => {},
        remover: 'a platform admin',
    });
}

// ---------------------------------------------------------------------------
// Account deletion (ADR-0007)
// ---------------------------------------------------------------------------

// Refuses (409) an account that is the last admin of a live body, naming every such
// body. A deactivated body holds nobody back, as a deactivated School does not (the
// spec's defaults). endSeats asks again under each body's lock.
async function assertNotLastAdmin(userId) {
    const seats = await prisma.governingBodyAdmin.findMany({
        where: { userId, ...SITTING, governingBody: { deactivatedAt: null } },
        select: { governingBody: { select: { name: true, _count: { select: { admins: { where: SITTING } } } } } },
    });

    const lastOf = seats
        .filter((seat) => seat.governingBody._count.admins === 1)
        .map((seat) => seat.governingBody.name);
    if (lastOf.length > 0) {
        throw conflict(`${LAST_ADMIN}, so this account cannot be deleted yet`, { governingBodies: lastOf });
    }
}

// What a deleted account holds at the bodies, ended inside the deletion's transaction:
// an application waiting is cancelled, a sitting seat ends LEFT with the reason. Each
// body is locked first, in one order, and its admins counted again: one who became the
// last meanwhile refuses the deletion whole. Returns each body's name and what came of
// the seat, for the answer.
async function endSeats(tx, { userId, now }) {
    const seats = await tx.governingBodyAdmin.findMany({
        where: { userId, status: { in: LIVE } },
        select: { id: true, status: true, governingBodyId: true, governingBody: { select: { name: true } } },
        orderBy: { governingBodyId: 'asc' },
    });

    const ended = [];
    for (const seat of seats) {
        if (seat.status === 'PENDING') {
            const claimed = await tx.governingBodyAdmin.updateMany({
                where: { id: seat.id, status: 'PENDING' },
                data: { status: 'CANCELLED', endedAt: now },
            });
            if (claimed.count === 0) throw conflict('An admin application of yours was decided meanwhile. Try again.');
            await recordAudit({
                subjectType: SEAT_SUBJECT,
                subjectId: seat.id,
                action: 'CANCEL',
                actorUserId: userId,
                client: tx,
            });
            ended.push({ governingBody: { name: seat.governingBody.name }, status: 'CANCELLED' });
            continue;
        }

        await lockGoverningBody(tx, seat.governingBodyId, now);
        const body = await tx.governingBody.findUnique({
            where: { id: seat.governingBodyId },
            select: {
                deactivatedAt: true,
                _count: { select: { admins: { where: { ...SITTING, id: { not: seat.id } } } } },
            },
        });
        if (!body.deactivatedAt && body._count.admins === 0) {
            throw conflict(`${LAST_ADMIN}, so this account cannot be deleted yet`, {
                governingBodies: [seat.governingBody.name],
            });
        }

        const reason = body.deactivatedAt ? ENDED_AT_DEACTIVATED_BODY : ENDED_BY_DELETION;
        const claimed = await tx.governingBodyAdmin.updateMany({
            where: { id: seat.id, ...SITTING },
            data: { status: 'LEFT', endedAt: now, endReason: reason },
        });
        if (claimed.count === 0) throw conflict('An admin seat of yours ended meanwhile. Try again.');
        await recordAudit({
            subjectType: SEAT_SUBJECT,
            subjectId: seat.id,
            action: 'LEAVE',
            actorUserId: userId,
            reason,
            client: tx,
        });
        ended.push({ governingBody: { name: seat.governingBody.name }, status: 'LEFT' });
    }

    return ended;
}

export {
    applyAsAdmin,
    listOwnSeats,
    cancelApplication,
    listAdmins,
    approveApplication,
    rejectApplication,
    removeAdmin,
    leaveGoverningBody,
    assertNotLastAdmin,
    endSeats,
    listAdminsOf,
    decideWithoutAdmin,
    removeAsPlatformAdmin,
};
