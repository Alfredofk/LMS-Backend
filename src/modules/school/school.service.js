import crypto from 'node:crypto';

import { prisma } from '../../shared/prisma.js';
import { runInSchool, runUnscoped } from '../../shared/tenantContext.js';
import { getStorage } from '../../shared/storage.js';
import { MIME } from '../../shared/upload.js';
import { SCHOOL_TYPES } from '../../shared/schoolType.js';
import {
    assertSchoolRegistrationAllowed,
    assertDecidable,
    assertRejectionReason,
    recordAudit,
} from '../../shared/approval.js';
import { isPrincipal } from '../../shared/guards.js';
import { AppError, conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import * as membershipService from '../membership/membership.service.js';
import { isStudentAnywhere } from '../membership/membership.eligibility.js';
import { closeWaitingApplications, discardKtps } from '../governingBody/governingBody.principals.js';
import { freeSubdomainOf } from './school.subdomain.js';
import { onTimeZoneChanged } from '../sessions/sessions.service.js';

const log = createLogger('School');

const SUBJECT_TYPE = 'SchoolRegistration';
// Deactivation is a decision about the School itself, not about the paperwork
// that founded it, so its audit rows carry the school's id as their subject.
const SCHOOL_SUBJECT = 'School';
const KTP_FOLDER = 'ktp';

// School Code: 8 characters, opaque, globally unique (ADR-0002, handoff #50).
//
// The alphabet drops 0/O and 1/I, because the code is read aloud in a classroom
// and typed from a WhatsApp message. 32 symbols over 8 places is 2^40 codes -
// far more than will ever exist, so a collision is rare and a retry is enough.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_ATTEMPTS = 5;

const randomCode = () =>
    Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');

// A code of that shape nobody holds yet, isTaken saying who would. The one generator of
// the School Code and the Governing Body Code (governing-body ticket 04), each unique in
// its own table: a code locates one thing, never which kind.
async function freeCodeOf(isTaken, what) {
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
        const code = randomCode();
        if (!(await isTaken(code))) return code;
    }
    throw new Error(`Could not find a free ${what} in ${CODE_ATTEMPTS} attempts`);
}

// client is a transaction's when the School is created in one, so Schools created
// together see each other's codes.
const generateSchoolCode = (client = prisma) =>
    freeCodeOf(
        async (code) => Boolean(await client.school.findUnique({ where: { schoolCode: code }, select: { id: true } })),
        'school code'
    );

// One School created, by the approval of its registration or by its Governing Body
// (governing-body ticket 05): its School Code and its K9 subdomain, both read inside
// the caller's transaction, so the Schools a body creates together see each other. The
// rest of the row is the caller's. One created at the same moment with the same NPSN,
// code or subdomain is refused by the unique index, and the caller's transaction with it.
async function createSchool(tx, fields) {
    const schoolCode = await generateSchoolCode(tx);
    const { schoolType, name, city } = fields;
    const subdomain = await freeSubdomainOf(tx, { schoolType, name, city });
    return tx.school.create({ data: { ...fields, schoolCode, subdomain } });
}

// One answer whether a School holds the NPSN or a registration waits on it, and never
// which school: the ticket forbids revealing it (ticket 04 of registration).
const NPSN_TAKEN = 'This NPSN is already registered or under review';

// The NPSNs among these that a School holds or an independent registration waits on,
// for a Governing Body's Schools (governing-body ticket 05). A fix leaves its own School
// aside.
async function npsnsTakenOf(npsns, { exceptSchoolId = null } = {}) {
    const [schools, waiting] = await Promise.all([
        prisma.school.findMany({
            where: { npsn: { in: npsns }, ...(exceptSchoolId ? { id: { not: exceptSchoolId } } : {}) },
            select: { npsn: true },
        }),
        prisma.schoolRegistration.findMany({
            where: { npsn: { in: npsns }, status: 'PENDING' },
            select: { npsn: true },
        }),
    ]);
    return new Set([...schools, ...waiting].map((row) => row.npsn));
}

// ---------------------------------------------------------------------------
// Views - what each side is allowed to see of a registration
// ---------------------------------------------------------------------------

// A school as either side sees it after approval. The applicant is the Principal,
// so they see the same four fields the admin does: being told your school was
// deactivated, and why, is the whole point of recording a reason.
const schoolView = (school) => ({
    id: school.id,
    name: school.name,
    schoolCode: school.schoolCode,
    subdomain: school.subdomain,
    // The Governing Body above it, for the admin's list (governing-body ticket 03).
    governingBody: school.governingBody ?? null,
    latitude: school.latitude ?? null,
    longitude: school.longitude ?? null,
    timeZone: school.timeZone ?? null,
    deactivatedAt: school.deactivatedAt ?? null,
    deactivationReason: school.deactivationReason ?? null,
});

// The KTP's storage path never leaves the server; whether one is on file does.
const adminView = (registration) => ({
    id: registration.id,
    npsn: registration.npsn,
    schoolName: registration.schoolName,
    schoolType: registration.schoolType,
    durationYears: registration.durationYears,
    city: registration.city,
    latitude: registration.latitude,
    longitude: registration.longitude,
    timeZone: registration.timeZone,
    applicantPhone: registration.applicantPhone,
    status: registration.status,
    hasKtp: Boolean(registration.ktpStoragePath),
    ktpVerifiedAt: registration.ktpVerifiedAt,
    reviewedAt: registration.reviewedAt,
    rejectionReason: registration.rejectionReason,
    createdSchoolId: registration.createdSchoolId,
    createdAt: registration.createdAt,
    // The school this registration became, once it became one. The admin screen
    // needs `deactivatedAt` to tell a live school from a switched-off one, and the
    // code so they can read it back to whoever lost it.
    school: registration.createdSchool ? schoolView(registration.createdSchool) : null,
    applicant: registration.applicant
        ? {
            id: registration.applicant.id,
            email: registration.applicant.email,
            fullName: registration.applicant.fullName,
        }
        : undefined,
});

const applicantView = (registration) => ({
    id: registration.id,
    npsn: registration.npsn,
    schoolName: registration.schoolName,
    schoolType: registration.schoolType,
    durationYears: registration.durationYears,
    city: registration.city,
    latitude: registration.latitude,
    longitude: registration.longitude,
    timeZone: registration.timeZone,
    applicantPhone: registration.applicantPhone,
    status: registration.status,
    rejectionReason: registration.rejectionReason,
    reviewedAt: registration.reviewedAt,
    createdAt: registration.createdAt,
    school: registration.createdSchool ? schoolView(registration.createdSchool) : null,
});

const applicantSelect = { select: { id: true, email: true, fullName: true } };
const createdSchoolSelect = {
    select: {
        id: true,
        name: true,
        schoolCode: true,
        subdomain: true,
        governingBody: { select: { id: true, name: true } },
        latitude: true,
        longitude: true,
        timeZone: true,
        deactivatedAt: true,
        deactivationReason: true,
    },
};

// ---------------------------------------------------------------------------
// Rules shared by submit and approve
// ---------------------------------------------------------------------------

// Approval makes the applicant this school's ACTIVE Principal. One who belongs to
// other schools may found one beside them (governing-body ticket 01, ADR-0011) - a
// new school is one where they hold nothing yet. A Student may not: they hold one
// membership on the whole platform (owner, 2026-10-18 K2).
async function assertNotStudent(userId, message) {
    if (await isStudentAnywhere(userId)) throw conflict(message);
}

// The KTP goes the moment a decision is made, approve or reject (UU PDP
// 27/2022). By the time this runs the column is already null and the decision
// committed, so a failure here cannot undo either - it is logged loudly with the
// key, for a human to remove the file by hand.
async function discardKtp(key, registrationId) {
    if (!key) return;
    try {
        await getStorage().remove(key);
    } catch (error) {
        log.error(
            `KTP for registration ${registrationId} was NOT removed from storage (${key}). ` +
                'Delete it by hand.',
            error
        );
    }
}

// ---------------------------------------------------------------------------
// Applicant
// ---------------------------------------------------------------------------

// A registration predates the school it asks for, so none of this has a school
// scope. The three models it writes or reads beyond SchoolRegistration -
// SchoolMembership, School and ApprovalAudit - are why it runs unscoped.
async function submitRegistration(userId, body, file) {
    return runUnscoped('a school registration predates the school it asks for', async () => {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { emailVerifiedAt: true, deletedAt: true },
        });
        if (!user || user.deletedAt) throw notFound('Account not found');
        // Unreachable through login today, which refuses an unverified account.
        // Kept because the ticket makes it a rule of this endpoint, not of login.
        if (!user.emailVerifiedAt) {
            throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address first');
        }

        await assertSchoolRegistrationAllowed({ applicantUserId: userId });

        const pending = await prisma.schoolRegistration.findFirst({
            where: { applicantUserId: userId, status: 'PENDING' },
            select: { id: true },
        });
        if (pending) throw conflict('You already have a school registration under review');

        await assertNotStudent(
            userId,
            'A student belongs to one school only, so cannot register a school'
        );

        // One answer whether a School holds the NPSN or another registration is
        // waiting on it, and never which school: the ticket forbids revealing it. A
        // Governing Body's School is the exception (governing-body ticket 05, K6c): the
        // applicant is told whose it is, and to ask it for the school's code (K8, owner
        // 2026-10-24). A private school's yayasan is printed on its SK operasional, so
        // the name discloses little.
        const holder = await prisma.school.findUnique({
            where: { npsn: body.npsn },
            select: { id: true, governingBody: { select: { name: true } } },
        });
        if (holder?.governingBody) {
            const { name } = holder.governingBody;
            const message =
                `This NPSN is registered by ${name}. ` +
                `Ask it for the school's code to apply as its Principal`;
            throw conflict(message, { governingBody: { name } });
        }
        const npsnTaken =
            holder ??
            (await prisma.schoolRegistration.findFirst({
                where: { npsn: body.npsn, status: 'PENDING' },
                select: { id: true },
            }));
        if (npsnTaken) throw conflict(NPSN_TAKEN);

        // Ticket 13: the Kemdikbud NPSN lookup belongs here, and its result is
        // information for the admin only - it never refuses a registration.

        const storage = getStorage();
        const key = await storage.save(file.buffer, {
            folder: KTP_FOLDER,
            originalName: `ktp.${file.detectedType}`,
        });

        try {
            const registration = await prisma.$transaction(async (tx) => {
                const created = await tx.schoolRegistration.create({
                    data: {
                        applicantUserId: userId,
                        npsn: body.npsn,
                        schoolName: body.schoolName,
                        schoolType: body.schoolType,
                        durationYears: body.durationYears,
                        city: body.city,
                        latitude: body.latitude,
                        longitude: body.longitude,
                        timeZone: body.timeZone,
                        applicantPhone: body.applicantPhone,
                        ktpStoragePath: key,
                    },
                });

                await recordAudit({
                    subjectType: SUBJECT_TYPE,
                    subjectId: created.id,
                    action: 'SUBMIT',
                    actorUserId: userId,
                    client: tx,
                });

                return created;
            });

            log.success(`School registration submitted: ${registration.schoolName} (${registration.npsn})`);
            return applicantView(registration);
        } catch (error) {
            // Nothing references the file now; it must not outlive the failure.
            await storage.remove(key).catch((removeError) =>
                log.error(`Orphaned KTP left in storage (${key}). Delete it by hand.`, removeError)
            );
            throw error;
        }
    });
}

async function listMine(userId) {
    const registrations = await prisma.schoolRegistration.findMany({
        where: { applicantUserId: userId },
        include: { createdSchool: createdSchoolSelect },
        orderBy: { createdAt: 'desc' },
    });
    return registrations.map(applicantView);
}

// ---------------------------------------------------------------------------
// Platform admin
// ---------------------------------------------------------------------------

const adminInclude = { applicant: applicantSelect, createdSchool: createdSchoolSelect };

// The filters, as one where clause.
//
// `q` is a contains match, case-insensitive, over the five fields an admin might
// half-remember - including two that live on the applicant, reached through the
// relation rather than by fetching everybody and sifting in JavaScript.
//
// Postgres cannot use a btree index for `contains`, so this is a sequential scan
// by design. At the scale of "schools applying to one platform" that is the right
// trade: a trigram index would cost writes on every registration to speed up a
// screen one person opens. Revisit it if the queue ever reaches six figures.
function buildRegistrationWhere({
    status,
    q,
    schoolType,
    city,
    deactivated,
    submittedFrom,
    submittedTo,
}) {
    const where = {};

    if (status && status !== 'ALL') where.status = status;
    if (schoolType) where.schoolType = schoolType;
    if (city) where.city = { contains: city, mode: 'insensitive' };

    if (q) {
        where.OR = [
            { schoolName: { contains: q, mode: 'insensitive' } },
            { npsn: { contains: q } },
            { city: { contains: q, mode: 'insensitive' } },
            { applicant: { fullName: { contains: q, mode: 'insensitive' } } },
            { applicant: { email: { contains: q, mode: 'insensitive' } } },
        ];
    }

    // Only an approved registration has a school, so either value of this implies
    // APPROVED: `true` is "switched off", `false` is "still running". A PENDING
    // row matches neither, which is the honest answer - there is nothing to be
    // deactivated yet.
    if (deactivated === true) where.createdSchool = { deactivatedAt: { not: null } };
    if (deactivated === false) where.createdSchool = { deactivatedAt: null };

    if (submittedFrom || submittedTo) {
        where.createdAt = {
            ...(submittedFrom ? { gte: submittedFrom } : {}),
            ...(submittedTo ? { lte: submittedTo } : {}),
        };
    }

    return where;
}

// One page of the queue, the number of rows behind that page, and the per-status
// totals the tab badges are made of.
//
// The counts are deliberately NOT filtered. A badge that shrinks as the admin
// types stops answering the question they opened the page to ask - is there work
// waiting - and the frontend says so in its own comments. `total` is the filtered
// number, for "37 results".
//
// Oldest first by default: a queue is worked from the front.
async function listRegistrations(filters) {
    const { sort, limit, offset } = filters;
    const where = buildRegistrationWhere(filters);

    const [registrations, total, grouped] = await Promise.all([
        prisma.schoolRegistration.findMany({
            where,
            include: adminInclude,
            orderBy: { createdAt: sort === 'newest' ? 'desc' : 'asc' },
            take: limit,
            skip: offset,
        }),
        prisma.schoolRegistration.count({ where }),
        prisma.schoolRegistration.groupBy({ by: ['status'], _count: { _all: true } }),
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
    const registration = await prisma.schoolRegistration.findUnique({
        where: { id },
        include: adminInclude,
    });
    if (!registration) throw notFound('School registration not found');
    return registration;
}

async function getRegistration(id) {
    return adminView(await loadRegistration(id));
}

async function readKtp(id) {
    const registration = await loadRegistration(id);
    const key = registration.ktpStoragePath;
    if (!key) throw notFound('No KTP is on file for this registration');

    const buffer = await getStorage().read(key);
    const type = key.endsWith('.png') ? 'png' : 'jpg';
    return { buffer, contentType: MIME[type] };
}

// Claiming the row with updateMany({ status: 'PENDING' }) inside the
// transaction is what makes a decision happen once. Two admins clicking at the
// same moment both pass assertDecidable() on their earlier read; only one of
// them can move the row out of PENDING, and the other gets the same 409.
async function claimPending(tx, id, data) {
    const claimed = await tx.schoolRegistration.updateMany({
        where: { id, status: 'PENDING' },
        data,
    });
    if (claimed.count === 0) throw conflict('This school registration has already been decided');
}

// Approval founds the school. In one transaction: the School with its code, the
// applicant's ACTIVE membership, their ACTIVE PRINCIPAL role - nobody else could
// have approved the first Principal - the decision on the registration, and the
// audit row. The KTP is removed only after all of that has committed.
//
// The applicant's current token carries no school. Their next /refresh rebuilds
// the claims (auth.service.js buildAuthClaims) and picks the school up.
async function approveRegistration(id, { adminId, adminUserId }) {
    return runUnscoped('a platform admin founding a school', async () => {
        const registration = await loadRegistration(id);
        assertDecidable(registration.status, 'school registration');

        const applicant = await prisma.user.findUnique({
            where: { id: registration.applicantUserId },
            select: { deletedAt: true },
        });
        if (!applicant || applicant.deletedAt) throw conflict('The applicant account no longer exists');

        await assertNotStudent(
            registration.applicantUserId,
            'The applicant is a student at a school, or has asked to be one, and a student belongs to one school only'
        );

        const now = new Date();

        const school = await prisma.$transaction(async (tx) => {
            await claimPending(tx, id, {
                status: 'APPROVED',
                reviewedByAdminId: adminId,
                reviewedAt: now,
                ktpVerifiedAt: now,
                ktpStoragePath: null,
            });

            const created = await createSchool(tx, {
                npsn: registration.npsn,
                name: registration.schoolName,
                schoolType: registration.schoolType,
                durationYears:
                    registration.durationYears ?? SCHOOL_TYPES[registration.schoolType].defaultDurationYears,
                city: registration.city,
                latitude: registration.latitude,
                longitude: registration.longitude,
                timeZone: registration.timeZone,
            });

            const membership = await tx.schoolMembership.create({
                data: {
                    schoolId: created.id,
                    userId: registration.applicantUserId,
                    status: 'ACTIVE',
                    approvedAt: now,
                },
            });

            await tx.membershipRole.create({
                data: {
                    schoolId: created.id,
                    membershipId: membership.id,
                    role: 'PRINCIPAL',
                    status: 'ACTIVE',
                    approvedByUserId: adminUserId,
                    approvedAt: now,
                },
            });

            await tx.schoolRegistration.update({
                where: { id },
                data: { createdSchoolId: created.id },
            });

            await recordAudit({
                subjectType: SUBJECT_TYPE,
                subjectId: id,
                action: 'APPROVE',
                actorUserId: adminUserId,
                client: tx,
            });

            return created;
        });

        await discardKtp(registration.ktpStoragePath, id);
        log.success(
            `School founded: ${school.name} (${school.npsn}), code ${school.schoolCode}, subdomain ${school.subdomain}`
        );

        return getRegistration(id);
    });
}

async function rejectRegistration(id, { adminId, adminUserId, reason }) {
    assertRejectionReason('REJECT', reason);
    const trimmed = reason.trim();

    return runUnscoped('a platform admin deciding a school registration', async () => {
        const registration = await loadRegistration(id);
        assertDecidable(registration.status, 'school registration');

        const now = new Date();

        await prisma.$transaction(async (tx) => {
            await claimPending(tx, id, {
                status: 'REJECTED',
                rejectionReason: trimmed,
                reviewedByAdminId: adminId,
                reviewedAt: now,
                ktpVerifiedAt: now,
                ktpStoragePath: null,
            });

            await recordAudit({
                subjectType: SUBJECT_TYPE,
                subjectId: id,
                action: 'REJECT',
                actorUserId: adminUserId,
                reason: trimmed,
                client: tx,
            });
        });

        await discardKtp(registration.ktpStoragePath, id);
        log.info(`School registration rejected: ${registration.schoolName} (${registration.npsn})`);

        return getRegistration(id);
    });
}

// ---------------------------------------------------------------------------
// Platform admin - every School
// ---------------------------------------------------------------------------

// The Platform Admin's list of Schools (governing-body ticket 05, owner 2026-10-24). It
// reads Schools, not registrations: a Governing Body's School has none, so the queue
// never shows it. Each row names its body (K11) and its registration, null for a body's.
// Since ticket 06b the Platform Admin deactivates, reactivates and appoints through the
// School's own id as well, and those routes answer with this row.
//
// Two more for the buttons (governing-body ticket 08's follow-up, 2026-10-26, from the
// frontend's note): the body's deactivatedAt, since the appointment (06b) and the
// Principal Applications (06c) wait for it, and deactivatedByPlatform, whether the
// deactivation is the Platform Admin's own, which a second press refuses, or the body's,
// which it takes over. The admin's id stays on the server.
const schoolListSelect = {
    id: true,
    npsn: true,
    name: true,
    schoolType: true,
    durationYears: true,
    city: true,
    subdomain: true,
    schoolCode: true,
    timeZone: true,
    governingBody: { select: { id: true, name: true, deactivatedAt: true } },
    registration: { select: { id: true } },
    deactivatedAt: true,
    deactivationReason: true,
    deactivatedByAdminId: true,
    createdAt: true,
};

const schoolListView = ({ governingBody, registration, deactivatedByAdminId, ...school }) => ({
    ...school,
    deactivatedByPlatform: Boolean(deactivatedByAdminId),
    governingBody: governingBody ?? null,
    registrationId: registration?.id ?? null,
});

// One School by its id, as the list shows it (governing-body ticket 06b).
async function loadListedSchool(id) {
    const school = await prisma.school.findUnique({ where: { id }, select: schoolListSelect });
    if (!school) throw notFound('School not found');
    return school;
}

const SCHOOL_ORDER = {
    name: [{ name: 'asc' }, { id: 'asc' }],
    newest: [{ createdAt: 'desc' }, { id: 'asc' }],
    oldest: [{ createdAt: 'asc' }, { id: 'asc' }],
};

// The filters, as one where clause. `contains` is a sequential scan by design, as the
// queue's is.
function buildSchoolWhere({ q, governingBodyId, governed, deactivated }) {
    const all = [];

    if (governingBodyId) all.push({ governingBodyId });
    if (governed !== undefined) all.push({ governingBodyId: governed ? { not: null } : null });
    if (deactivated !== undefined) all.push({ deactivatedAt: deactivated ? { not: null } : null });
    if (q) {
        all.push({
            OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { npsn: { contains: q } },
                { city: { contains: q, mode: 'insensitive' } },
                { subdomain: { contains: q, mode: 'insensitive' } },
            ],
        });
    }

    return all.length ? { AND: all } : {};
}

// One page of Schools and the number behind it.
async function listSchools(filters) {
    const { sort, limit, offset } = filters;
    const where = buildSchoolWhere(filters);

    const [schools, total] = await Promise.all([
        prisma.school.findMany({
            where,
            select: schoolListSelect,
            orderBy: SCHOOL_ORDER[sort],
            take: limit,
            skip: offset,
        }),
        prisma.school.count({ where }),
    ]);

    return { schools: schools.map(schoolListView), total, page: { limit, offset, returned: schools.length } };
}

// ---------------------------------------------------------------------------
// Withdrawing a school's access - and giving it back
// ---------------------------------------------------------------------------

// Deactivation. The Platform Admin reaches a School through its registration, the row
// the queue holds, or through its own id, which every School has (governing-body ticket
// 06b, the spec's K10': a Governing Body's School has no registration, and the brake
// must reach it). Both come to withdrawAccess.
//
// What it does, and does not do:
// - `School.deactivatedAt` is set, with the reason and the admin who decided.
//   buildAuthClaims() then issues no school claims to any member, so their tokens
//   carry no schoolId and every tenant-owned query is out of reach; the School
//   Code stops resolving for new joins.
// - Live sign-ins are cut, because an access token is minted from a refresh token:
//   leaving those alone would let a member renew their way back in for up to
//   fourteen days. Revoking them means the school is gone at the next refresh -
//   within one access-token lifetime (JWT_ACCESS_TTL, 15 minutes by default) for
//   somebody holding a valid one right now.
// - Only the sign-ins for this school (governing-body ticket 01): those bound to
//   it, and a member's bound to none, which their next refresh could open here.
//   A member's sign-ins at their other schools go on.
// - **Nothing is deleted, and no membership changes.** Ending memberships is
//   leaving, which is ADR-0004 and ticket 06; a school that comes back should find
//   its people still in it.
//
// Runs unscoped, opened by the caller: the sign-ins it cuts span schools. Since
// governing-body ticket 08 a Governing Body's admin switches off its own School through it
// too, with adminId null: deactivatedByAdminId then says the body did, and only a
// Platform Admin's deactivation is one the body may not undo. A Platform Admin braking a
// School its body has already switched off takes that deactivation over
// (takeOverDeactivation).
//
// The body's claim also names its governingBodyId (ticket 08's follow-up, 2026-10-26): a
// release pressed at the same moment by another of its admins wins, and this one gets the
// 404 a School no longer the body's gets. Before, the School could end up independent and
// switched off by a body it had left, which only the Platform Admin could undo.
async function withdrawAccess(school, { adminId = null, adminUserId, reason, governingBodyId = null }) {
    if (school.deactivatedAt) {
        if (adminId) return takeOverDeactivation(school, { adminId, adminUserId, reason });
        throw conflict('This school is already deactivated');
    }

    const trimmed = reason.trim();
    const schoolId = school.id;
    const now = new Date();

    const cutSessions = await prisma.$transaction(async (tx) => {
        // Claimed the same way a registration decision is: two admins clicking
        // together both pass the read above, and only one moves the row.
        const claimed = await tx.school.updateMany({
            where: { id: schoolId, deactivatedAt: null, ...(governingBodyId ? { governingBodyId } : {}) },
            data: {
                deactivatedAt: now,
                deactivationReason: trimmed,
                deactivatedByAdminId: adminId,
            },
        });
        if (claimed.count === 0) {
            if (governingBodyId && !(await tx.school.count({ where: { id: schoolId, governingBodyId } }))) {
                throw notFound('School not found');
            }
            throw conflict('This school is already deactivated');
        }

        const members = await tx.schoolMembership.findMany({
            where: { schoolId, status: 'ACTIVE' },
            select: { userId: true },
        });
        const userIds = [...new Set(members.map((entry) => entry.userId))];

        const revoked = await tx.refreshToken.updateMany({
            where: {
                revokedAt: null,
                OR: [{ schoolId }, { schoolId: null, userId: { in: userIds } }],
            },
            data: { revokedAt: now },
        });

        await recordAudit({
            schoolId,
            subjectType: SCHOOL_SUBJECT,
            subjectId: schoolId,
            action: 'DEACTIVATE',
            actorUserId: adminUserId,
            reason: trimmed,
            client: tx,
        });

        return revoked.count;
    });

    log.info(
        `School deactivated: ${school.name} (${school.npsn}) - ` +
            `${cutSessions} session(s) revoked. Reason: ${trimmed}`
    );
}

// A Platform Admin deactivating a School its Governing Body has already switched off
// (governing-body ticket 08, owner 2026-10-26, option B): the deactivation becomes the
// Platform Admin's, deactivatedByAdminId and its reason, so the body can no longer undo
// it. Before, the 409 "already deactivated" read as the brake being on when it was not,
// and the way round - reactivate, then deactivate - left the School running between the
// two. It stays off throughout: deactivatedAt keeps the body's moment, and its sign-ins
// were cut then. The claim is the rule: one a Platform Admin already holds is the same
// 409 as ever. The body's reason stays in ApprovalAudit.
async function takeOverDeactivation(school, { adminId, adminUserId, reason }) {
    const trimmed = reason.trim();

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.school.updateMany({
            where: { id: school.id, deactivatedAt: { not: null }, deactivatedByAdminId: null },
            data: { deactivationReason: trimmed, deactivatedByAdminId: adminId },
        });
        if (claimed.count === 0) throw conflict('This school is already deactivated');

        await recordAudit({
            schoolId: school.id,
            subjectType: SCHOOL_SUBJECT,
            subjectId: school.id,
            action: 'DEACTIVATE',
            actorUserId: adminUserId,
            reason: trimmed,
            client: tx,
        });
    });

    log.info(`School deactivation taken over by a platform admin: ${school.name} (${school.npsn}). Reason: ${trimmed}`);
}

// Keyed by the registration: only an APPROVED one has a school to switch off.
async function deactivateSchool(id, reviewer) {
    assertRejectionReason('DEACTIVATE', reviewer.reason);

    return runUnscoped('a platform admin withdrawing a whole school access', async () => {
        const registration = await loadRegistration(id);

        if (registration.status !== 'APPROVED' || !registration.createdSchoolId) {
            throw conflict('Only an approved registration has a school to deactivate', {
                status: registration.status,
            });
        }

        await withdrawAccess(await loadListedSchool(registration.createdSchoolId), reviewer);
        return getRegistration(id);
    });
}

// POST /api/admin/schools/:id/deactivate: keyed by the School, any School, a Governing
// Body's included (governing-body ticket 06b). Answers the School as the list shows it.
async function deactivateSchoolById(id, reviewer) {
    assertRejectionReason('DEACTIVATE', reviewer.reason);

    return runUnscoped('a platform admin withdrawing a whole school access', async () => {
        await withdrawAccess(await loadListedSchool(id), reviewer);
        return schoolListView(await loadListedSchool(id));
    });
}

const NOT_DEACTIVATED = 'This school is not deactivated';
const BRAKE = 'The Platform Admin deactivated this school, so only the Platform Admin reactivates it';

// Why a Governing Body's claim to reactivate found nothing, read after the claim so it
// names what won (ticket 08's follow-up, 2026-10-26, from the frontend's note): the School
// running already, as when the button was pressed twice, or the Platform Admin's brake.
// Before, one message named both, and a second press read as the brake.
async function restoreRefusalOf(tx, schoolId) {
    const school = await tx.school.findUnique({
        where: { id: schoolId },
        select: { deactivatedAt: true, deactivatedByAdminId: true },
    });
    if (!school.deactivatedAt) return NOT_DEACTIVATED;
    if (school.deactivatedByAdminId) return BRAKE;
    return 'This school changed meanwhile';
}

// The way back. The frontend has no button for it yet, and it exists anyway: a
// school switched off by a misclick would otherwise need the database edited by
// hand. The note is optional - there is nobody waiting to be told why their access
// came back - but it is recorded when given.
//
// Members have to sign in again: their sign-ins for this school were revoked on
// the way out, and reactivating does not un-revoke them. That is deliberate. A revoked token
// coming back to life is exactly the shape of a replay, and auth.service.js treats
// it as theft.
//
// onlyTheBodys (governing-body ticket 08): a Governing Body restores only what it switched
// off, so its claim also wants deactivatedByAdminId empty. The claim is the whole rule,
// the brake included; what it lost to is read after it (restoreRefusalOf).
async function restoreAccess(school, { adminUserId, reason, onlyTheBodys = false }) {
    if (!school.deactivatedAt) throw conflict(NOT_DEACTIVATED);

    const note = reason?.trim() ? reason.trim() : null;
    const schoolId = school.id;

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.school.updateMany({
            where: {
                id: schoolId,
                deactivatedAt: { not: null },
                ...(onlyTheBodys ? { deactivatedByAdminId: null } : {}),
            },
            data: {
                deactivatedAt: null,
                deactivationReason: null,
                deactivatedByAdminId: null,
            },
        });
        if (claimed.count === 0) {
            throw conflict(onlyTheBodys ? await restoreRefusalOf(tx, schoolId) : NOT_DEACTIVATED);
        }

        // The reason is cleared from the row, not from the record: why a school
        // was switched off lives in ApprovalAudit, which is append-only
        // (ADR-0003). Leaving a stale reason on a running school would be worse
        // than losing it - it reads as current.
        await recordAudit({
            schoolId,
            subjectType: SCHOOL_SUBJECT,
            subjectId: schoolId,
            action: 'REACTIVATE',
            actorUserId: adminUserId,
            reason: note,
            client: tx,
        });
    });

    log.success(`School reactivated: ${school.name} (${school.npsn})`);
}

// Keyed by the registration.
async function reactivateSchool(id, reviewer) {
    return runUnscoped('a platform admin restoring a school access', async () => {
        const registration = await loadRegistration(id);
        if (!registration.createdSchoolId) throw notFound('This registration has no school');

        await restoreAccess(await loadListedSchool(registration.createdSchoolId), reviewer);
        return getRegistration(id);
    });
}

// POST /api/admin/schools/:id/reactivate: keyed by the School (governing-body ticket 06b).
async function reactivateSchoolById(id, reviewer) {
    return runUnscoped('a platform admin restoring a school access', async () => {
        await restoreAccess(await loadListedSchool(id), reviewer);
        return schoolListView(await loadListedSchool(id));
    });
}

// ---------------------------------------------------------------------------
// Principal - the School Code
// ---------------------------------------------------------------------------

// School Code rotation (ticket 06). The mitigation that makes ADR-0002's join-code
// model defensible: once a code has spread beyond the people it was meant for,
// the Principal replaces it.
//
// - The old code stops resolving at once: resolveSchool() looks the code up by
//   unique value, and nothing else remembers it.
// - Requests already PENDING are untouched. They name the school by id; the code
//   only located it, and they are past that.
// - A deactivated school cannot rotate. Its members' tokens stop carrying the
//   school at the next refresh, and one still in flight is refused here, since a
//   code that resolves nowhere has nothing worth replacing.
//
// Principal checked against the database rather than the token's roles, the way
// guards.js reads status - a role withdrawn minutes ago must not still work.
async function rotateSchoolCode(auth) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden('Only the Principal can do this');

    const schoolCode = await generateSchoolCode();

    const school = await prisma.$transaction(async (tx) => {
        const claimed = await tx.school.updateMany({
            where: { id: auth.schoolId, deactivatedAt: null },
            data: { schoolCode },
        });
        if (claimed.count === 0) throw notFound('School not found');

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: SCHOOL_SUBJECT,
            subjectId: auth.schoolId,
            action: 'REGENERATE_CODE',
            actorUserId: auth.userId,
            client: tx,
        });

        return tx.school.findUnique({ where: { id: auth.schoolId }, ...createdSchoolSelect });
    });

    log.info(`School Code regenerated for ${school.name}`);
    return schoolView(school);
}

// The Principal correcting the school's point (teaching-and-learning ticket 01).
// The registrant may have picked it from a phone somewhere else, and students'
// check-ins are measured against it. Audited, with the old point in the reason,
// so a moved school can be traced - check-ins flagged before the move were
// flagged against the old point. Refused at a deactivated school, as rotation is.
async function updateSchoolLocation(auth, { latitude, longitude }) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden('Only the Principal can do this');

    const school = await prisma.$transaction(async (tx) => {
        const before = await tx.school.findUnique({
            where: { id: auth.schoolId },
            select: { latitude: true, longitude: true, deactivatedAt: true },
        });
        const claimed = await tx.school.updateMany({
            where: { id: auth.schoolId, deactivatedAt: null },
            data: { latitude, longitude },
        });
        if (!before || claimed.count === 0) throw notFound('School not found');

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: SCHOOL_SUBJECT,
            subjectId: auth.schoolId,
            action: 'UPDATE_LOCATION',
            actorUserId: auth.userId,
            reason:
                before.latitude === null
                    ? 'No point before'
                    : `Was ${before.latitude}, ${before.longitude}`,
            client: tx,
        });

        return tx.school.findUnique({ where: { id: auth.schoolId }, ...createdSchoolSelect });
    });

    log.info(`School location corrected for ${school.name}`);
    return schoolView(school);
}

// The Principal changing the school's time zone (teaching-and-learning ticket 07).
// Audited with the zone before. It stays changeable once the school has Sessions
// (ticket 09, owner 2026-09-28): those from tomorrow keep their wall-clock time in
// the new zone, and past ones and today's stay where they were - in the same
// transaction, so the zone and the Sessions never disagree.
async function updateSchoolTimeZone(auth, { timeZone }) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden('Only the Principal can do this');

    let moved = 0;
    const school = await prisma.$transaction(async (tx) => {
        const before = await tx.school.findUnique({
            where: { id: auth.schoolId },
            select: { timeZone: true },
        });
        const claimed = await tx.school.updateMany({
            where: { id: auth.schoolId, deactivatedAt: null },
            data: { timeZone },
        });
        if (!before || claimed.count === 0) throw notFound('School not found');

        if (before.timeZone && before.timeZone !== timeZone) {
            moved = await onTimeZoneChanged(tx, auth.schoolId, before.timeZone, timeZone);
        }
        if (before.timeZone !== timeZone) {
            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: SCHOOL_SUBJECT,
                subjectId: auth.schoolId,
                action: 'UPDATE_TIME_ZONE',
                actorUserId: auth.userId,
                reason: before.timeZone ? `Was ${before.timeZone}` : 'No time zone before',
                client: tx,
            });
        }

        return tx.school.findUnique({ where: { id: auth.schoolId }, ...createdSchoolSelect });
    });

    log.info(`School time zone set to ${timeZone} for ${school.name}; ${moved} session(s) moved`);
    return schoolView(school);
}

// A Platform Admin appointing a school's Principal (owner, 2026-09-27), through its
// registration, the row the queue holds, or since governing-body ticket 06b through
// its own id. Works on a deactivated school too: one restored without a Principal
// needs this before anyone can run it.
//
// A Governing Body's School takes one only while its body is deactivated (the spec's
// K10'). While the body runs, the body appoints, through a Principal Application
// (ticket 06). The applications still waiting there close in the appointment's
// transaction, as an approval closes them, and their KTPs go after the commit.
const BODY_APPOINTS = 'Its governing body appoints its Principal';

// What an appointment reads of its School: its name for the scope, and its body's state.
const appointedSchoolSelect = { id: true, name: true, governingBody: { select: { deactivatedAt: true } } };

async function appointPrincipalAt(school, { adminUserId, email, reason }) {
    if (school.governingBody && !school.governingBody.deactivatedAt) throw conflict(BODY_APPOINTS);

    let closedKeys = [];
    const result = await runInSchool(school.id, school.name, () =>
        membershipService.appointPrincipal({
            schoolId: school.id,
            email,
            reason,
            adminUserId,
            alongside: async (tx, now) => {
                closedKeys = await closeWaitingApplications(tx, { schoolId: school.id, actorUserId: adminUserId, now });
            },
        })
    );

    await discardKtps(closedKeys);
    log.info(
        `A Principal was appointed at ${school.name} by a platform admin; ` +
            `${closedKeys.length} application(s) waiting there closed`
    );
    return result;
}

// Keyed by the registration.
async function appointPrincipal(id, reviewer) {
    const registration = await runUnscoped('a platform admin appointing a Principal', async () =>
        await loadRegistration(id)
    );
    if (registration.status !== 'APPROVED' || !registration.createdSchoolId) {
        throw conflict('Only an approved registration has a school to appoint a Principal for', {
            status: registration.status,
        });
    }

    const school = await prisma.school.findUnique({
        where: { id: registration.createdSchoolId },
        select: appointedSchoolSelect,
    });

    const result = await appointPrincipalAt(school, reviewer);
    return { school: { id: school.id, name: school.name }, ...result };
}

// POST /api/admin/schools/:id/principal: keyed by the School, any School, a Governing
// Body's included (governing-body ticket 06b). Answers the School as the list shows it,
// with the Principal and the ones before.
async function appointPrincipalById(id, reviewer) {
    const school = await prisma.school.findUnique({ where: { id }, select: appointedSchoolSelect });
    if (!school) throw notFound('School not found');

    const result = await appointPrincipalAt(school, reviewer);
    return { school: schoolListView(await loadListedSchool(id)), ...result };
}

export {
    CODE_ALPHABET,
    CODE_LENGTH,
    freeCodeOf,
    createSchool,
    NPSN_TAKEN,
    npsnsTakenOf,
    discardKtp,
    submitRegistration,
    listMine,
    listRegistrations,
    listSchools,
    getRegistration,
    readKtp,
    approveRegistration,
    rejectRegistration,
    withdrawAccess,
    restoreAccess,
    deactivateSchool,
    deactivateSchoolById,
    reactivateSchool,
    reactivateSchoolById,
    appointPrincipal,
    appointPrincipalById,
    rotateSchoolCode,
    updateSchoolLocation,
    updateSchoolTimeZone,
};
