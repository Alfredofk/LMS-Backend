import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
import { getStorage } from '../../shared/storage.js';
import { MIME } from '../../shared/upload.js';
import {
    assertGoverningBodyRegistrationAllowed,
    assertDecidable,
    assertRejectionReason,
    recordAudit,
} from '../../shared/approval.js';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { assertEligibleApplicant } from '../membership/membership.service.js';
import { isStudentAnywhere } from '../membership/membership.eligibility.js';
import { freeCodeOf } from '../school/school.service.js';
import { freeGoverningBodySubdomainOf } from '../school/school.subdomain.js';

const log = createLogger('GoverningBody');

// The Governing Body (governing-body ticket 03, the spec's K1, K5, K11, K13): a
// yayasan, a perkumpulan or a Dinas above its Schools. It registers as a School does,
// a Platform Admin checks it by hand, and approval creates it with its first admin.
// The same shape as a School Registration (school.service.js), and its patterns.
//
// Owner's decisions (2026-10-18; the build plan, 2026-10-22):
// - A registration gives the name, the kind, the full address (every part but the
//   postal code required), the applicant's phone, their KTP and a proof of office: the
//   akta page listing the pengurus, or the Kepala Dinas's surat tugas. A FOUNDATION or
//   an ASSOCIATION gives its Kemenkumham SK number, unique on the platform; a GOVERNMENT
//   body has none.
// - The KTP is a JPG or PNG of at most 2 MB, the proof a PDF, JPG or PNG of at most
//   5 MB. Both are discarded the moment a decision is made (UU PDP 27/2022); the
//   numbers stay.
// - One registration waits at a time per applicant, five a day at most. A Student may
//   not register one, as they may not register a School.
// - Approval creates, in one transaction, the body with its Governing Body Code and its
//   K13 subdomain, and the applicant's ACTIVE admin seat.
// - Decisions are audited against `GoverningBodyRegistration`; a body's deactivation,
//   reactivation and correction against `GoverningBody`; `schoolId` null throughout.
// - Deactivation (K11): its admins lose it, its code and subdomain stop resolving, the
//   sign-ins bound to it end, and its Schools keep running. Reversible.
// - A Platform Admin corrects its name, kind and SK number. The subdomain does not
//   follow a rename (K9).
//
// Its admins (governing-body ticket 04, owner 2026-10-18 and the plan of 2026-10-24),
// beside the seats' lifecycle in governingBody.admins.js:
// - The Governing Body Code locates the body and grants nothing. A signed-in, verified
//   account that is no Student looks it up; an unknown or deactivated one is one 404.
// - Any admin rotates it, audited: the old one stops at once, and the applications
//   already waiting are untouched.
// - Any admin changes its address and phone, audited with what they were. The name,
//   the kind and the SK number stay the Platform Admin's.
// - Account deletion closes a registration still under review, and both its files go
//   (users.service.js, ADR-0007).
//
// Every table here is above tenancy (UNSCOPED_MODELS). ApprovalAudit is tenant-owned,
// so every write that records one runs unscoped, as a School Registration's does.

const REGISTRATION_SUBJECT = 'GoverningBodyRegistration';
const BODY_SUBJECT = 'GoverningBody';
const KTP_FOLDER = 'governing-body-ktp';
const PROOF_FOLDER = 'governing-body-proof';

// One answer whether a body holds the number or a registration waits on it, and never
// which body: the same answer the NPSN check gives (ticket 04 of registration).
const SK_TAKEN = 'This SK number is already registered or under review';

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const addressOf = (row) => ({
    street: row.street,
    village: row.village,
    district: row.district,
    city: row.city,
    province: row.province,
    postalCode: row.postalCode,
});

const bodyView = (body) => ({
    id: body.id,
    kind: body.kind,
    name: body.name,
    skNumber: body.skNumber,
    address: addressOf(body),
    phone: body.phone,
    code: body.code,
    subdomain: body.subdomain,
    deactivatedAt: body.deactivatedAt,
    deactivationReason: body.deactivationReason,
    createdAt: body.createdAt,
});

// The files' storage paths never leave the server; whether they are on file does.
const adminView = (registration) => ({
    id: registration.id,
    kind: registration.kind,
    name: registration.name,
    skNumber: registration.skNumber,
    address: addressOf(registration),
    applicantPhone: registration.applicantPhone,
    status: registration.status,
    hasKtp: Boolean(registration.ktpStoragePath),
    hasProof: Boolean(registration.proofStoragePath),
    reviewedAt: registration.reviewedAt,
    rejectionReason: registration.rejectionReason,
    createdAt: registration.createdAt,
    governingBody: registration.createdGoverningBody ? bodyView(registration.createdGoverningBody) : null,
    applicant: registration.applicant
        ? {
            id: registration.applicant.id,
            email: registration.applicant.email,
            fullName: registration.applicant.fullName,
        }
        : undefined,
});

// The applicant reads their own, and once approved the body's code and subdomain: the
// code is how the admins after them ask to join (ticket 04).
const applicantView = (registration) => ({
    id: registration.id,
    kind: registration.kind,
    name: registration.name,
    skNumber: registration.skNumber,
    address: addressOf(registration),
    applicantPhone: registration.applicantPhone,
    status: registration.status,
    rejectionReason: registration.rejectionReason,
    reviewedAt: registration.reviewedAt,
    createdAt: registration.createdAt,
    governingBody: registration.createdGoverningBody
        ? {
            id: registration.createdGoverningBody.id,
            name: registration.createdGoverningBody.name,
            code: registration.createdGoverningBody.code,
            subdomain: registration.createdGoverningBody.subdomain,
        }
        : null,
});

const applicantSelect = { select: { id: true, email: true, fullName: true } };
const adminInclude = { applicant: applicantSelect, createdGoverningBody: true };

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

// A stored file's type, from the extension it was saved with (storage.js keeps it).
function typeOfKey(key) {
    if (key.endsWith('.png')) return 'png';
    if (key.endsWith('.pdf')) return 'pdf';
    return 'jpg';
}

// Both files go the moment a decision is made, an account's deletion included. By the
// time this runs the columns are null and the decision committed, so a failure cannot
// undo it: it is logged loudly with the key, for a human to remove the file by hand.
async function discardRegistrationFiles(registration) {
    for (const key of [registration.ktpStoragePath, registration.proofStoragePath]) {
        if (!key) continue;
        try {
            await getStorage().remove(key);
        } catch (error) {
            log.error(
                `A file of governing body registration ${registration.id} was NOT removed from storage (${key}). ` +
                    'Delete it by hand.',
                error
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Applicant
// ---------------------------------------------------------------------------

// A number some body holds, or a registration still waits on - the applicant's own
// waiting one aside, for a correction.
async function isSkNumberTaken(skNumber, { exceptBodyId = null } = {}) {
    const [body, waiting] = await Promise.all([
        prisma.governingBody.findFirst({
            where: { skNumber, ...(exceptBodyId ? { id: { not: exceptBodyId } } : {}) },
            select: { id: true },
        }),
        prisma.governingBodyRegistration.findFirst({ where: { skNumber, status: 'PENDING' }, select: { id: true } }),
    ]);
    return Boolean(body || waiting);
}

// POST /api/governing-body-registrations, multipart: the fields and two files. The files
// are saved first and removed again if the row is not written.
async function submitRegistration(userId, body, files) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { emailVerifiedAt: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw notFound('Account not found');
    if (!user.emailVerifiedAt) {
        throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address first');
    }

    await assertGoverningBodyRegistrationAllowed({ applicantUserId: userId });

    const pending = await prisma.governingBodyRegistration.findFirst({
        where: { applicantUserId: userId, status: 'PENDING' },
        select: { id: true },
    });
    if (pending) throw conflict('You already have a governing body registration under review');

    if (await isStudentAnywhere(userId)) {
        throw conflict('A student belongs to one school only, so cannot register a governing body');
    }
    if (body.skNumber && (await isSkNumberTaken(body.skNumber))) throw conflict(SK_TAKEN);

    const storage = getStorage();
    const ktpKey = await storage.save(files.ktp.buffer, {
        folder: KTP_FOLDER,
        originalName: `ktp.${files.ktp.detectedType}`,
    });
    let proofKey = null;

    try {
        proofKey = await storage.save(files.proof.buffer, {
            folder: PROOF_FOLDER,
            originalName: `proof.${files.proof.detectedType}`,
        });

        const registration = await runUnscoped('a governing body registration predates the body', async () =>
            await prisma.$transaction(async (tx) => {
                const created = await tx.governingBodyRegistration.create({
                    data: {
                        applicantUserId: userId,
                        kind: body.kind,
                        name: body.name,
                        skNumber: body.skNumber ?? null,
                        street: body.street,
                        village: body.village,
                        district: body.district,
                        city: body.city,
                        province: body.province,
                        postalCode: body.postalCode ?? null,
                        applicantPhone: body.applicantPhone,
                        ktpStoragePath: ktpKey,
                        proofStoragePath: proofKey,
                    },
                    include: { createdGoverningBody: true },
                });

                await recordAudit({
                    subjectType: REGISTRATION_SUBJECT,
                    subjectId: created.id,
                    action: 'SUBMIT',
                    actorUserId: userId,
                    client: tx,
                });

                return created;
            })
        );

        log.success(`Governing body registration submitted: ${registration.name} (${registration.kind})`);
        return applicantView(registration);
    } catch (error) {
        // Nothing references the files now; they must not outlive the failure.
        for (const key of [ktpKey, proofKey].filter(Boolean)) {
            await storage.remove(key).catch((removeError) =>
                log.error(`Orphaned file left in storage (${key}). Delete it by hand.`, removeError)
            );
        }
        throw error;
    }
}

async function listMine(userId) {
    const registrations = await prisma.governingBodyRegistration.findMany({
        where: { applicantUserId: userId },
        include: { createdGoverningBody: true },
        orderBy: { createdAt: 'desc' },
    });
    return registrations.map(applicantView);
}

// ---------------------------------------------------------------------------
// Platform Admin - the queue
// ---------------------------------------------------------------------------

// The filters, as one where clause - the School queue's, with the kind for the type and
// the SK number for the NPSN. `contains` is a sequential scan by design, at this scale.
function buildRegistrationWhere({ status, q, kind, deactivated, submittedFrom, submittedTo }) {
    const where = {};

    if (status && status !== 'ALL') where.status = status;
    if (kind) where.kind = kind;

    if (q) {
        where.OR = [
            { name: { contains: q, mode: 'insensitive' } },
            { skNumber: { contains: q, mode: 'insensitive' } },
            { city: { contains: q, mode: 'insensitive' } },
            { applicant: { fullName: { contains: q, mode: 'insensitive' } } },
            { applicant: { email: { contains: q, mode: 'insensitive' } } },
        ];
    }

    if (deactivated === true) where.createdGoverningBody = { deactivatedAt: { not: null } };
    if (deactivated === false) where.createdGoverningBody = { deactivatedAt: null };

    if (submittedFrom || submittedTo) {
        where.createdAt = {
            ...(submittedFrom ? { gte: submittedFrom } : {}),
            ...(submittedTo ? { lte: submittedTo } : {}),
        };
    }

    return where;
}

// One page, its filtered total, and the unfiltered per-status counts for the tabs.
async function listRegistrations(filters) {
    const { sort, limit, offset } = filters;
    const where = buildRegistrationWhere(filters);

    const [registrations, total, grouped] = await Promise.all([
        prisma.governingBodyRegistration.findMany({
            where,
            include: adminInclude,
            orderBy: { createdAt: sort === 'newest' ? 'desc' : 'asc' },
            take: limit,
            skip: offset,
        }),
        prisma.governingBodyRegistration.count({ where }),
        prisma.governingBodyRegistration.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
    for (const row of grouped) counts[row.status] = row._count._all;

    return {
        registrations: registrations.map(adminView),
        total,
        counts,
        page: { limit, offset, returned: registrations.length },
    };
}

async function loadRegistration(id) {
    const registration = await prisma.governingBodyRegistration.findUnique({ where: { id }, include: adminInclude });
    if (!registration) throw notFound('Governing body registration not found');
    return registration;
}

async function getRegistration(id) {
    return adminView(await loadRegistration(id));
}

// The KTP or the proof, while on file: until the decision.
async function readFile(id, which) {
    const registration = await loadRegistration(id);
    const key = which === 'ktp' ? registration.ktpStoragePath : registration.proofStoragePath;
    if (!key) throw notFound(`No ${which === 'ktp' ? 'KTP' : 'proof of office'} is on file for this registration`);

    return { buffer: await getStorage().read(key), contentType: MIME[typeOfKey(key)] };
}

// ---------------------------------------------------------------------------
// Platform Admin - deciding
// ---------------------------------------------------------------------------

// A decision happens once: two admins clicking together both pass assertDecidable on
// their earlier read, and only one moves the row out of PENDING.
async function claimPending(tx, id, data) {
    const claimed = await tx.governingBodyRegistration.updateMany({ where: { id, status: 'PENDING' }, data });
    if (claimed.count === 0) throw conflict('This governing body registration has already been decided');
}

// Unique among bodies; a collision is rare and a retry is enough, as for School Codes.
const generateGoverningBodyCode = () =>
    freeCodeOf(
        async (code) => Boolean(await prisma.governingBody.findUnique({ where: { code }, select: { id: true } })),
        'governing body code'
    );

// Approval creates the body. In one transaction: the decision, the body with its code
// and K13 subdomain, the applicant's ACTIVE seat - nobody else could have approved the
// first admin - and the audit row. Both files go after the commit.
async function approveRegistration(id, { adminId, adminUserId }) {
    return runUnscoped('a platform admin founding a governing body', async () => {
        const registration = await loadRegistration(id);
        assertDecidable(registration.status, 'governing body registration');

        const applicant = await prisma.user.findUnique({
            where: { id: registration.applicantUserId },
            select: { deletedAt: true },
        });
        if (!applicant || applicant.deletedAt) throw conflict('The applicant account no longer exists');
        if (await isStudentAnywhere(registration.applicantUserId)) {
            throw conflict(
                'The applicant is a student at a school, or has asked to be one, and a student belongs to ' +
                    'one school only'
            );
        }
        if (registration.skNumber) {
            const held = await prisma.governingBody.findFirst({
                where: { skNumber: registration.skNumber },
                select: { id: true },
            });
            if (held) throw conflict('This SK number is already registered');
        }

        const code = await generateGoverningBodyCode();
        const now = new Date();

        const body = await prisma.$transaction(async (tx) => {
            await claimPending(tx, id, {
                status: 'APPROVED',
                reviewedByAdminId: adminId,
                reviewedAt: now,
                ktpStoragePath: null,
                proofStoragePath: null,
            });

            const created = await tx.governingBody.create({
                data: {
                    kind: registration.kind,
                    name: registration.name,
                    skNumber: registration.skNumber,
                    street: registration.street,
                    village: registration.village,
                    district: registration.district,
                    city: registration.city,
                    province: registration.province,
                    postalCode: registration.postalCode,
                    code,
                    subdomain: await freeGoverningBodySubdomainOf(tx, registration),
                },
            });

            await tx.governingBodyAdmin.create({
                data: {
                    governingBodyId: created.id,
                    userId: registration.applicantUserId,
                    status: 'ACTIVE',
                    approvedAt: now,
                },
            });

            await tx.governingBodyRegistration.update({
                where: { id },
                data: { createdGoverningBodyId: created.id },
            });

            await recordAudit({
                subjectType: REGISTRATION_SUBJECT,
                subjectId: id,
                action: 'APPROVE',
                actorUserId: adminUserId,
                client: tx,
            });

            return created;
        });

        await discardRegistrationFiles(registration);
        log.success(
            `Governing body founded: ${body.name} (${body.kind}), code ${body.code}, subdomain ${body.subdomain}`
        );

        return getRegistration(id);
    });
}

async function rejectRegistration(id, { adminId, adminUserId, reason }) {
    assertRejectionReason('REJECT', reason);
    const trimmed = reason.trim();

    return runUnscoped('a platform admin deciding a governing body registration', async () => {
        const registration = await loadRegistration(id);
        assertDecidable(registration.status, 'governing body registration');

        await prisma.$transaction(async (tx) => {
            await claimPending(tx, id, {
                status: 'REJECTED',
                rejectionReason: trimmed,
                reviewedByAdminId: adminId,
                reviewedAt: new Date(),
                ktpStoragePath: null,
                proofStoragePath: null,
            });

            await recordAudit({
                subjectType: REGISTRATION_SUBJECT,
                subjectId: id,
                action: 'REJECT',
                actorUserId: adminUserId,
                reason: trimmed,
                client: tx,
            });
        });

        await discardRegistrationFiles(registration);
        log.info(`Governing body registration rejected: ${registration.name}`);

        return getRegistration(id);
    });
}

// ---------------------------------------------------------------------------
// Platform Admin - a body
// ---------------------------------------------------------------------------

async function loadGoverningBody(id) {
    const body = await prisma.governingBody.findUnique({ where: { id } });
    if (!body) throw notFound('Governing body not found');
    return body;
}

// Correcting the name, the kind or the SK number (the spec's defaults: they are the
// Platform Admin's). The kind and the number must still agree: a GOVERNMENT body has
// no SK number, the others one. The subdomain stays (K9). Audited with what it was.
async function updateGoverningBody(adminUserId, id, patch) {
    return runUnscoped('a platform admin correcting a governing body', async () => {
        const body = await loadGoverningBody(id);
        const next = {
            name: patch.name ?? body.name,
            kind: patch.kind ?? body.kind,
            skNumber: patch.skNumber === undefined ? body.skNumber : patch.skNumber,
        };

        if (next.kind !== 'GOVERNMENT' && !next.skNumber) {
            throw badRequest('A foundation or an association has a Kemenkumham SK number');
        }
        if (next.kind === 'GOVERNMENT' && next.skNumber) {
            throw badRequest('A government body has no Kemenkumham SK number');
        }
        const changedSk = next.skNumber && next.skNumber !== body.skNumber;
        if (changedSk && (await isSkNumberTaken(next.skNumber, { exceptBodyId: id }))) {
            throw conflict(SK_TAKEN);
        }

        try {
            await prisma.$transaction(async (tx) => {
                const claimed = await tx.governingBody.updateMany({
                    where: { id, updatedAt: body.updatedAt },
                    data: next,
                });
                if (claimed.count === 0) throw conflict('This governing body changed meanwhile');

                await recordAudit({
                    subjectType: BODY_SUBJECT,
                    subjectId: id,
                    action: 'UPDATE_GOVERNING_BODY',
                    actorUserId: adminUserId,
                    reason: `Was "${body.name}", ${body.kind}, SK ${body.skNumber ?? 'none'}`,
                    client: tx,
                });
            });
        } catch (error) {
            if (error?.code === 'P2002') throw conflict(SK_TAKEN);
            throw error;
        }

        log.info(`Governing body corrected: ${next.name}`);
        return bodyView(await loadGoverningBody(id));
    });
}

// K11. Its admins lose it, its code and subdomain stop resolving, and its sign-ins
// end: those bound to it, and its admins' bound to none, which their next refresh
// could open here - as a School's deactivation does. Its Schools keep running: their
// own sign-ins are bound to them, not to it. Nothing is deleted; no seat changes.
async function deactivateGoverningBody(id, { adminId, adminUserId, reason }) {
    assertRejectionReason('DEACTIVATE', reason);
    const trimmed = reason.trim();

    return runUnscoped('a platform admin withdrawing a governing body', async () => {
        const body = await loadGoverningBody(id);
        if (body.deactivatedAt) throw conflict('This governing body is already deactivated');
        const now = new Date();

        const cut = await prisma.$transaction(async (tx) => {
            const claimed = await tx.governingBody.updateMany({
                where: { id, deactivatedAt: null },
                data: { deactivatedAt: now, deactivationReason: trimmed, deactivatedByAdminId: adminId },
            });
            if (claimed.count === 0) throw conflict('This governing body is already deactivated');

            const seats = await tx.governingBodyAdmin.findMany({
                where: { governingBodyId: id, status: 'ACTIVE' },
                select: { userId: true },
            });
            const revoked = await tx.refreshToken.updateMany({
                where: {
                    revokedAt: null,
                    OR: [
                        { governingBodyId: id },
                        { schoolId: null, governingBodyId: null, userId: { in: seats.map((seat) => seat.userId) } },
                    ],
                },
                data: { revokedAt: now },
            });

            await recordAudit({
                subjectType: BODY_SUBJECT,
                subjectId: id,
                action: 'DEACTIVATE',
                actorUserId: adminUserId,
                reason: trimmed,
                client: tx,
            });

            return revoked.count;
        });

        log.info(`Governing body deactivated: ${body.name} - ${cut} sign-in(s) revoked. Reason: ${trimmed}`);
        return bodyView(await loadGoverningBody(id));
    });
}

// The way back. Its admins sign in again: the sign-ins cut on the way out stay cut, a
// revoked token coming back to life being the shape of a replay. The reason it was
// switched off is cleared from the row and kept in ApprovalAudit.
async function reactivateGoverningBody(id, { adminUserId, reason }) {
    const note = reason?.trim() ? reason.trim() : null;

    return runUnscoped('a platform admin restoring a governing body', async () => {
        const body = await loadGoverningBody(id);
        if (!body.deactivatedAt) throw conflict('This governing body is not deactivated');

        await prisma.$transaction(async (tx) => {
            const claimed = await tx.governingBody.updateMany({
                where: { id, deactivatedAt: { not: null } },
                data: { deactivatedAt: null, deactivationReason: null, deactivatedByAdminId: null },
            });
            if (claimed.count === 0) throw conflict('This governing body is not deactivated');

            await recordAudit({
                subjectType: BODY_SUBJECT,
                subjectId: id,
                action: 'REACTIVATE',
                actorUserId: adminUserId,
                reason: note,
                client: tx,
            });
        });

        log.info(`Governing body reactivated: ${body.name}`);
        return bodyView(await loadGoverningBody(id));
    });
}

// ---------------------------------------------------------------------------
// The Governing Body Code
// ---------------------------------------------------------------------------

// The body a code locates. GoverningBody is above tenancy, so this reads without a
// scope. An unknown code and a deactivated body's answer alike (K11): saying "this
// body is switched off" would name it to somebody who is not in it.
async function resolveGoverningBody(code) {
    const body = await prisma.governingBody.findUnique({
        where: { code },
        select: { id: true, name: true, kind: true, deactivatedAt: true },
    });
    if (!body || body.deactivatedAt) throw notFound('No governing body uses that code');
    return body;
}

// The public identity a code reveals, and nothing more: no admin, no School, no id. A
// Principal applies through the School's own code instead (ticket 06, owner 2026-10-24).
const publicBodyView = (body) => ({ name: body.name, kind: body.kind });

// POST /api/governing-body-applications/lookup. A Student is refused here already:
// they may ask for nothing this code leads to.
async function lookupGoverningBody(userId, { code }) {
    await assertEligibleApplicant(userId);
    const body = await resolveGoverningBody(code);
    if (await isStudentAnywhere(userId)) {
        throw conflict('A student belongs to one school only, so cannot apply to a governing body');
    }
    return publicBodyView(body);
}

// Any admin replaces the code, as the Principal replaces a School Code (ticket 06 of
// registration): the old one stops resolving at once, since resolveGoverningBody looks
// it up by its unique value, and the applications already waiting name the body by id.
async function rotateGoverningBodyCode(auth) {
    const code = await generateGoverningBodyCode();

    await runUnscoped('an admin replacing a governing body code', async () =>
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.governingBody.updateMany({
                where: { id: auth.governingBodyId, deactivatedAt: null },
                data: { code },
            });
            if (claimed.count === 0) throw notFound('Governing body not found');

            await recordAudit({
                subjectType: BODY_SUBJECT,
                subjectId: auth.governingBodyId,
                action: 'REGENERATE_CODE',
                actorUserId: auth.userId,
                client: tx,
            });
        })
    );

    const body = await loadGoverningBody(auth.governingBodyId);
    log.info(`Governing Body Code regenerated for ${body.name}`);
    return bodyView(body);
}

// ---------------------------------------------------------------------------
// The seat
// ---------------------------------------------------------------------------

// GET /api/governing-body: the body the token's seat is for, with its code
// (requireGoverningBodyAdmin has read the seat). The dashboard is ticket 07's.
async function ownGoverningBody(auth) {
    return bodyView(await loadGoverningBody(auth.governingBodyId));
}

const PROFILE_FIELDS = ['street', 'village', 'district', 'city', 'province', 'postalCode', 'phone'];

const shown = (value) => (value === null ? 'none' : `"${value}"`);

// PATCH /api/governing-body: any admin changes the address and the phone (the spec's
// defaults). The fields not sent stay; postalCode and phone clear to null. Audited
// with what each changed field was, as the Platform Admin's correction is; a patch
// that changes nothing writes nothing. The subdomain does not follow the city (K9).
async function updateProfile(auth, patch) {
    const body = await loadGoverningBody(auth.governingBodyId);
    const changes = PROFILE_FIELDS.filter((key) => patch[key] !== undefined && patch[key] !== body[key]);
    if (changes.length === 0) return bodyView(body);

    const data = Object.fromEntries(changes.map((key) => [key, patch[key]]));
    await runUnscoped('an admin changing a governing body address', async () =>
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.governingBody.updateMany({
                where: { id: body.id, updatedAt: body.updatedAt, deactivatedAt: null },
                data,
            });
            if (claimed.count === 0) throw conflict('This governing body changed meanwhile');

            await recordAudit({
                subjectType: BODY_SUBJECT,
                subjectId: body.id,
                action: 'UPDATE_GOVERNING_BODY',
                actorUserId: auth.userId,
                reason: changes.map((key) => `${key} was ${shown(body[key])}`).join('; '),
                client: tx,
            });
        })
    );

    log.info(`Governing body ${body.name}: ${changes.join(', ')} changed by an admin`);
    return bodyView(await loadGoverningBody(body.id));
}

export {
    BODY_SUBJECT,
    discardRegistrationFiles,
    resolveGoverningBody,
    publicBodyView,
    lookupGoverningBody,
    rotateGoverningBodyCode,
    updateProfile,
    submitRegistration,
    listMine,
    listRegistrations,
    getRegistration,
    readFile,
    approveRegistration,
    rejectRegistration,
    updateGoverningBody,
    deactivateGoverningBody,
    reactivateGoverningBody,
    ownGoverningBody,
    loadGoverningBody,
};
