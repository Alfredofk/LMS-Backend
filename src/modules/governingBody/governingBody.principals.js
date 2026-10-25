import { prisma } from '../../shared/prisma.js';
import { runInSchool, runUnscoped } from '../../shared/tenantContext.js';
import { getStorage } from '../../shared/storage.js';
import { MIME } from '../../shared/upload.js';
import {
    SCHOOL_HAS_PRINCIPAL,
    assertDecidable,
    assertPrincipalApplicationRetryAllowed,
    assertRejectionReason,
    recordAudit,
} from '../../shared/approval.js';
import { conflict, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import {
    SITTING_PRINCIPAL,
    assertEligibleApplicant,
    isAwaitingPrincipal,
    lockSchool,
    resolveSchool,
} from '../membership/membership.service.js';
import { assertMayJoin, assertStudentAlone, isStudentAnywhere } from '../membership/membership.eligibility.js';

const log = createLogger('GoverningBody');

// Principal applications (governing-body ticket 06, the spec's K8): the person who will
// head a Governing Body's School asks for it, and an admin of the body decides, as a
// Platform Admin decides a School Registration.
//
// Owner's decisions (2026-10-18; K8 changed 2026-10-24; the plan, 2026-10-25):
// - The applicant enters the School's own code, which the body hands to the person it
//   wants (GET /api/governing-body/schools). There is no dropdown. Only a Governing Body's
//   School with no Principal sitting takes an application, and while it has none its code
//   takes nothing else (isAwaitingPrincipal in membership.service.js). An independent
//   School keeps today's path.
// - The application is the code, the applicant's phone and their KTP. One waiting per
//   person per School; the applicant may cancel; three rejections a day at one School at
//   most, an automatic one not counted (approval.js).
// - Several may apply for one School. Any admin of the body decides, not only the senior
//   (K6), and may decide their own application, audited with themselves as the actor
//   (owner, 2026-10-25): the body appoints its Principal.
// - Approval gives an ACTIVE membership with PRINCIPAL alone, as a School Registration's
//   approval gives its founder; teaching is asked for afterwards. The others waiting for
//   that School are rejected on their own (SCHOOL_HAS_PRINCIPAL). One Principal per School
//   (ADR-0008) holds under lockSchool, so of two approvals at once the second gets 409.
// - A Platform Admin's appointment at a body's School, allowed while the body is
//   deactivated (ticket 06b, K10'), closes the applications waiting there too, in its
//   own transaction (closeWaitingApplications, shared with the approval).
// - A submission takes the same lock (owner, 2026-10-25, option A). Without it, one sent
//   while another applicant was approved was left waiting at a School that has its
//   Principal: 7 of 10 rounds in the probe. Now it lands before the approval, which closes
//   it with the others, or after, and is refused.
// - A member of that School may not apply (owner, 2026-10-25, against the proposal): its
//   body makes one of its teachers its Principal (ticket 08), and a Guardian there leaves
//   first, since a Principal should be a teacher (owner, 2026-10-25, asked again). A
//   Student may not apply, and a waiting application refuses a STUDENT request anywhere
//   (membership.eligibility.js).
// - Every KTP is discarded on its decision, an automatic rejection, a cancel and an
//   account's deletion included (UU PDP 27/2022, the spec's invariant 7).
// - Above tenancy (owner, 2026-10-25): PrincipalApplication is in UNSCOPED_MODELS, its
//   schoolId a plain column, read by the body's admins through their seat. The membership
//   and the role are written in the School's own scope. Audited against
//   `PrincipalApplication` with the School's id, so the School's own trail shows how its
//   Principal came.

const SUBJECT = 'PrincipalApplication';
const KTP_FOLDER = 'principal-application-ktp';
const MISSING = 'Principal application not found';

const NOT_GOVERNED = 'Only a school run by a governing body takes applications to be its Principal';
const HAS_PRINCIPAL = 'This school has a Principal';
const MEMBER_HERE =
    'You already belong to this school, or have asked to join it, so you cannot apply to be its Principal. ' +
    'Its governing body makes one of its teachers the Principal. A guardian here leaves the school first, ' +
    'then applies';

const schoolSelect = {
    select: { id: true, name: true, schoolType: true, city: true, governingBody: { select: { name: true } } },
};
const personSelect = { select: { id: true, fullName: true, email: true, deletedAt: true } };
const adminInclude = {
    school: { select: { id: true, name: true } },
    applicant: personSelect,
    decidedBy: { select: { id: true, fullName: true } },
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// The applicant's own: where they asked, what came of it, and why. The School is named,
// never by its id: holding its code is the only way to name a School to the applicant's
// routes, as at the lookup.
const ownView = (application) => ({
    id: application.id,
    status: application.status,
    school: {
        name: application.school.name,
        schoolType: application.school.schoolType,
        city: application.school.city,
    },
    governingBody: application.school.governingBody ? { name: application.school.governingBody.name } : null,
    applicantPhone: application.applicantPhone,
    requestedAt: application.createdAt,
    decidedAt: application.decidedAt,
    rejectionReason: application.rejectionReason,
});

// An application as the body's admins see it: who asks, how to reach them, and whether
// the KTP is still on file. Its storage path stays on the server.
const adminView = (application) => ({
    id: application.id,
    status: application.status,
    school: { id: application.school.id, name: application.school.name },
    applicant: {
        id: application.applicant.id,
        fullName: application.applicant.fullName,
        email: application.applicant.deletedAt ? null : application.applicant.email,
    },
    applicantPhone: application.applicantPhone,
    hasKtp: Boolean(application.ktpStoragePath),
    requestedAt: application.createdAt,
    decidedAt: application.decidedAt,
    decidedBy: application.decidedBy
        ? { id: application.decidedBy.id, fullName: application.decidedBy.fullName }
        : null,
    rejectionReason: application.rejectionReason,
});

// ---------------------------------------------------------------------------
// The KTP
// ---------------------------------------------------------------------------

// The KTPs of decided applications. By the time this runs their columns are null and the
// decision committed, so a failure cannot undo it: it is logged loudly with the key, for a
// human to remove the file by hand, as discardKtp does for a School Registration.
async function discardKtps(keys) {
    for (const key of keys) {
        if (!key) continue;
        try {
            await getStorage().remove(key);
        } catch (error) {
            log.error(`A Principal application's KTP was NOT removed from storage (${key}). Delete it by hand.`, error);
        }
    }
}

// ---------------------------------------------------------------------------
// The applicant
// ---------------------------------------------------------------------------

// Whether the person holds or has asked for a membership at this School, read in its
// scope. A member is refused (MEMBER_HERE) before assertMayJoin's own sentence, which
// tells a member to ask for another role, and PRINCIPAL is not one that is asked for.
const isLiveMemberAt = (school, userId) =>
    runInSchool(school.id, school.name, async () =>
        Boolean(
            await prisma.schoolMembership.findFirst({
                where: { userId, status: { in: ['PENDING', 'ACTIVE'] } },
                select: { id: true },
            })
        )
    );

// POST /api/principal-applications, multipart: the School Code, the phone and the KTP.
// Refuses an unverified account (403), an unknown or deactivated code (404), a School
// that takes no application - independent, or with a Principal - a member of it, a
// Student, a second application waiting there, and the fourth rejection of a day (409).
// The KTP is saved first and removed again if the row is not written. The row is written
// under the School's lock, the one an approval takes, with the Principal checked again.
async function submitApplication(userId, body, file) {
    await assertEligibleApplicant(userId);
    const school = await resolveSchool(body.schoolCode);
    if (!school.governingBodyId) throw conflict(NOT_GOVERNED);
    // The early answer, before the KTP is saved. The one that decides is under the lock.
    if (!(await isAwaitingPrincipal(school))) throw conflict(HAS_PRINCIPAL);
    if (await isLiveMemberAt(school, userId)) throw conflict(MEMBER_HERE);
    // The Student rule, both ways: a Student anywhere is refused, as at the lookup.
    await assertMayJoin(userId, school.id);

    const waiting = await prisma.principalApplication.findFirst({
        where: { userId, schoolId: school.id, status: 'PENDING' },
        select: { id: true },
    });
    if (waiting) throw conflict('You already have a Principal application waiting at this school');
    await assertPrincipalApplicationRetryAllowed({ userId, schoolId: school.id });

    const storage = getStorage();
    const key = await storage.save(file.buffer, { folder: KTP_FOLDER, originalName: `ktp.${file.detectedType}` });

    try {
        // In the School's scope for the Principal's role; the application itself is above
        // tenancy and passes through it.
        const application = await runInSchool(school.id, school.name, async () =>
            await prisma.$transaction(async (tx) => {
                // An approval holding the lock commits first, so its Principal is seen here.
                // Holding it first, this commits first, and the approval closes this row
                // with the others waiting.
                await lockSchool(tx, school.id, new Date());
                if (await tx.membershipRole.findFirst({ where: SITTING_PRINCIPAL, select: { id: true } })) {
                    throw conflict(HAS_PRINCIPAL);
                }

                const created = await tx.principalApplication.create({
                    data: {
                        schoolId: school.id,
                        userId,
                        applicantPhone: body.applicantPhone,
                        ktpStoragePath: key,
                    },
                    include: { school: schoolSelect },
                });

                await recordAudit({
                    schoolId: school.id,
                    subjectType: SUBJECT,
                    subjectId: created.id,
                    action: 'SUBMIT',
                    actorUserId: userId,
                    client: tx,
                });

                return created;
            })
        );

        log.info(`Principal application at ${school.name}`);
        return ownView(application);
    } catch (error) {
        await storage.remove(key).catch((removeError) =>
            log.error(`Orphaned KTP left in storage (${key}). Delete it by hand.`, removeError)
        );
        // Two applications racing past the check above: the partial index is the rule.
        if (error?.code === 'P2002') {
            throw conflict('You already have a Principal application waiting at this school');
        }
        throw error;
    }
}

// GET /api/principal-applications/mine: every application of theirs, newest first, with
// its outcome and a rejection's reason.
async function listOwnApplications(userId) {
    const applications = await prisma.principalApplication.findMany({
        where: { userId },
        include: { school: schoolSelect },
        orderBy: { createdAt: 'desc' },
    });
    return applications.map(ownView);
}

// POST /api/principal-applications/:id/cancel: taking a waiting application back.
// CANCELLED, never counted against the cap, and the KTP goes. Claimed, so an admin
// deciding at the same moment and the applicant cancelling cannot both win.
async function cancelApplication(userId, id) {
    const application = await prisma.principalApplication.findFirst({
        where: { id, userId, status: 'PENDING' },
        include: { school: schoolSelect },
    });
    if (!application) throw notFound('No Principal application of yours is waiting under that id');

    const now = new Date();
    await runUnscoped('an applicant cancelling a principal application', async () =>
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.principalApplication.updateMany({
                where: { id: application.id, status: 'PENDING' },
                data: { status: 'CANCELLED', decidedAt: now, ktpStoragePath: null },
            });
            if (claimed.count === 0) throw conflict('This Principal application has already been decided');

            await recordAudit({
                schoolId: application.schoolId,
                subjectType: SUBJECT,
                subjectId: application.id,
                action: 'CANCEL',
                actorUserId: userId,
                client: tx,
            });
        })
    );

    await discardKtps([application.ktpStoragePath]);
    log.info(`Principal application cancelled at ${application.school.name}`);
    return ownView({ ...application, status: 'CANCELLED', decidedAt: now });
}

// ---------------------------------------------------------------------------
// The body's admins
// ---------------------------------------------------------------------------

// One application to one of the body's Schools. Another body's, or none, is one 404.
async function loadOwnApplication(auth, id) {
    const application = await prisma.principalApplication.findFirst({
        where: { id, school: { governingBodyId: auth.governingBodyId } },
        include: adminInclude,
    });
    if (!application) throw notFound(MISSING);
    return application;
}

// GET /api/governing-body/schools/:id/principal-applications, for any admin: one of the
// body's Schools' applications, the waiting ones by default, oldest first, as a queue is
// worked. Another body's School is 404.
async function listForSchool(auth, schoolId, { status }) {
    const school = await prisma.school.findFirst({
        where: { id: schoolId, governingBodyId: auth.governingBodyId },
        select: { id: true },
    });
    if (!school) throw notFound('School not found');

    const applications = await prisma.principalApplication.findMany({
        where: { schoolId: school.id, ...(status === 'ALL' ? {} : { status }) },
        include: adminInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return applications.map(adminView);
}

async function getApplication(auth, id) {
    return adminView(await loadOwnApplication(auth, id));
}

// The KTP, while on file: until the decision.
async function readKtp(auth, id) {
    const key = (await loadOwnApplication(auth, id)).ktpStoragePath;
    if (!key) throw notFound('No KTP is on file for this application');

    const buffer = await getStorage().read(key);
    return { buffer, contentType: MIME[key.endsWith('.png') ? 'png' : 'jpg'] };
}

// The applications still waiting for a School that has its Principal now, in the
// transaction that made them one and under the School's lock: an admin's approval here,
// or a Platform Admin's appointment (governing-body ticket 06b). Each is claimed on its
// own out of PENDING and rejected with SCHOOL_HAS_PRINCIPAL, decided and audited by the
// one who made the Principal. One its applicant cancelled a moment ago is left as it is,
// unaudited here. Returns the KTPs it closed, for the caller to discard after the commit.
async function closeWaitingApplications(tx, { schoolId, actorUserId, now }) {
    const waiting = await tx.principalApplication.findMany({
        where: { schoolId, status: 'PENDING' },
        select: { id: true, ktpStoragePath: true },
    });

    const keys = [];
    for (const application of waiting) {
        const closed = await tx.principalApplication.updateMany({
            where: { id: application.id, status: 'PENDING' },
            data: {
                status: 'REJECTED',
                rejectionReason: SCHOOL_HAS_PRINCIPAL,
                decidedByUserId: actorUserId,
                decidedAt: now,
                ktpStoragePath: null,
            },
        });
        if (closed.count === 0) continue;

        await recordAudit({
            schoolId,
            subjectType: SUBJECT,
            subjectId: application.id,
            action: 'REJECT',
            actorUserId,
            reason: SCHOOL_HAS_PRINCIPAL,
            client: tx,
        });
        keys.push(application.ktpStoragePath);
    }
    return keys;
}

// POST /api/governing-body/principal-applications/:id/approve, for any admin. In one
// transaction in the School's scope, under the School's lock: no Principal sitting (409),
// the claim out of PENDING, the applicant's ACTIVE membership with PRINCIPAL alone, the
// other applications waiting there rejected on their own, and the audit rows. Every KTP
// it closed is removed after the commit. Works on a deactivated School too, as a Platform
// Admin's appointment does (ADR-0008): one restored needs its Principal.
async function approveApplication(auth, id) {
    const application = await loadOwnApplication(auth, id);
    assertDecidable(application.status, 'Principal application');
    if (application.applicant.deletedAt) throw conflict('The applicant account no longer exists');
    if (await isStudentAnywhere(application.userId)) {
        throw conflict(
            'The applicant is a student at a school, or has asked to be one, and a student belongs to one school only'
        );
    }

    const { school } = application;
    const now = new Date();

    let closedKeys;
    try {
        closedKeys = await runInSchool(school.id, school.name, async () =>
            await prisma.$transaction(async (tx) => {
                await lockSchool(tx, school.id, now);
                if (await tx.membershipRole.findFirst({ where: SITTING_PRINCIPAL, select: { id: true } })) {
                    throw conflict(SCHOOL_HAS_PRINCIPAL);
                }

                const claimed = await tx.principalApplication.updateMany({
                    where: { id: application.id, status: 'PENDING' },
                    data: { status: 'APPROVED', decidedByUserId: auth.userId, decidedAt: now, ktpStoragePath: null },
                });
                if (claimed.count === 0) throw conflict('This Principal application has already been decided');

                // schoolId is stamped by the tenant extension on both creates.
                const membership = await tx.schoolMembership.create({
                    data: { userId: application.userId, status: 'ACTIVE', approvedAt: now },
                });
                await tx.membershipRole.create({
                    data: {
                        membershipId: membership.id,
                        role: 'PRINCIPAL',
                        status: 'ACTIVE',
                        approvedByUserId: auth.userId,
                        approvedAt: now,
                    },
                });
                await assertStudentAlone(tx, {
                    userId: application.userId,
                    membershipId: membership.id,
                    releasing: ['PRINCIPAL'],
                });

                await recordAudit({
                    schoolId: school.id,
                    subjectType: SUBJECT,
                    subjectId: application.id,
                    action: 'APPROVE',
                    actorUserId: auth.userId,
                    client: tx,
                });

                // The others waiting for this School; the approved one is out of PENDING.
                const others = await closeWaitingApplications(tx, {
                    schoolId: school.id,
                    actorUserId: auth.userId,
                    now,
                });
                return [application.ktpStoragePath, ...others];
            })
        );
    } catch (error) {
        // The membership index: the applicant joined this School between the read and
        // the write. A member may not head it through an application (owner, 2026-10-25).
        if (error?.code === 'P2002') {
            throw conflict('The applicant joined this school meanwhile, so cannot be approved through an application');
        }
        throw error;
    }

    await discardKtps(closedKeys);
    log.info(
        `A Principal application was approved at ${school.name}; ` +
            `${closedKeys.length - 1} other(s) waiting there closed`
    );
    return adminView(await loadOwnApplication(auth, application.id));
}

// POST /api/governing-body/principal-applications/:id/reject, for any admin, with a
// reason the applicant reads. The KTP goes after the commit.
async function rejectApplication(auth, id, { reason } = {}) {
    assertRejectionReason('REJECT', reason);
    const trimmed = reason.trim();

    const application = await loadOwnApplication(auth, id);
    assertDecidable(application.status, 'Principal application');
    const now = new Date();

    await runUnscoped('a governing body admin rejecting a principal application', async () =>
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.principalApplication.updateMany({
                where: { id: application.id, status: 'PENDING' },
                data: {
                    status: 'REJECTED',
                    rejectionReason: trimmed,
                    decidedByUserId: auth.userId,
                    decidedAt: now,
                    ktpStoragePath: null,
                },
            });
            if (claimed.count === 0) throw conflict('This Principal application has already been decided');

            await recordAudit({
                schoolId: application.schoolId,
                subjectType: SUBJECT,
                subjectId: application.id,
                action: 'REJECT',
                actorUserId: auth.userId,
                reason: trimmed,
                client: tx,
            });
        })
    );

    await discardKtps([application.ktpStoragePath]);
    log.info(`A Principal application was rejected at ${application.school.name}`);
    return adminView(await loadOwnApplication(auth, application.id));
}

// ---------------------------------------------------------------------------
// Account deletion (ADR-0007)
// ---------------------------------------------------------------------------

// What a deleted account waits for, cancelled inside the deletion's transaction, as a
// waiting join request is. Returns the Schools' names, for the answer, and the KTPs, for
// the caller to discard after its commit.
async function cancelOnDeletion(tx, { userId, now }) {
    const waiting = await tx.principalApplication.findMany({
        where: { userId, status: 'PENDING' },
        select: { id: true, schoolId: true, ktpStoragePath: true, school: { select: { name: true } } },
    });

    for (const application of waiting) {
        const claimed = await tx.principalApplication.updateMany({
            where: { id: application.id, status: 'PENDING' },
            data: { status: 'CANCELLED', decidedAt: now, ktpStoragePath: null },
        });
        if (claimed.count === 0) {
            throw conflict('A Principal application of yours was decided meanwhile. Try again.');
        }
        await recordAudit({
            schoolId: application.schoolId,
            subjectType: SUBJECT,
            subjectId: application.id,
            action: 'CANCEL',
            actorUserId: userId,
            client: tx,
        });
    }

    return {
        schools: waiting.map((application) => ({ name: application.school.name })),
        ktpKeys: waiting.map((application) => application.ktpStoragePath),
    };
}

export {
    submitApplication,
    listOwnApplications,
    cancelApplication,
    listForSchool,
    getApplication,
    readKtp,
    approveApplication,
    rejectApplication,
    closeWaitingApplications,
    cancelOnDeletion,
    discardKtps,
};
