import crypto from 'node:crypto';

import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
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

const log = createLogger('School');

const SUBJECT_TYPE = 'SchoolRegistration';
// Deactivation is a decision about the School itself, not about the paperwork
// that founded it, so its audit rows carry the school's id as their subject.
const SCHOOL_SUBJECT = 'School';
const KTP_FOLDER = 'ktp';

/*
  School Code: 8 characters, opaque, globally unique (ADR-0002, handoff #50).

  The alphabet drops 0/O and 1/I, because the code is read aloud in a classroom
  and typed from a WhatsApp message. 32 symbols over 8 places is 2^40 codes -
  far more than will ever exist, so a collision is rare and a retry is enough.
*/
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_ATTEMPTS = 5;

async function generateSchoolCode() {
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
        const code = Array.from(
            { length: CODE_LENGTH },
            () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
        ).join('');

        const taken = await prisma.school.findUnique({
            where: { schoolCode: code },
            select: { id: true },
        });
        if (!taken) return code;
    }
    throw new Error(`Could not find a free school code in ${CODE_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------
// Views - what each side is allowed to see of a registration
// ---------------------------------------------------------------------------

/*
  A school as either side sees it after approval. The applicant is the Principal,
  so they see the same four fields the admin does: being told your school was
  deactivated, and why, is the whole point of recording a reason.
*/
const schoolView = (school) => ({
    id: school.id,
    name: school.name,
    schoolCode: school.schoolCode,
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
    applicantPhone: registration.applicantPhone,
    status: registration.status,
    hasKtp: Boolean(registration.ktpStoragePath),
    ktpVerifiedAt: registration.ktpVerifiedAt,
    reviewedAt: registration.reviewedAt,
    rejectionReason: registration.rejectionReason,
    createdSchoolId: registration.createdSchoolId,
    createdAt: registration.createdAt,
    /*
      The school this registration became, once it became one. The admin screen
      needs `deactivatedAt` to tell a live school from a switched-off one, and the
      code so they can read it back to whoever lost it.
    */
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
        deactivatedAt: true,
        deactivationReason: true,
    },
};

// ---------------------------------------------------------------------------
// Rules shared by submit and approve
// ---------------------------------------------------------------------------

/*
  One pending-or-active membership per User (ADR-0002, and the partial unique
  index behind it). Approval makes the applicant an ACTIVE Principal, so someone
  who already belongs somewhere - or has asked to - cannot found a school.

  SchoolMembership is tenant-owned; callers run this inside runUnscoped(),
  because the question is precisely "which school, if any".
*/
async function assertHoldsNoMembership(userId, message) {
    const held = await prisma.schoolMembership.findFirst({
        where: { userId, status: { in: ['PENDING', 'ACTIVE'] } },
        select: { id: true },
    });
    if (held) throw conflict(message);
}

/*
  The KTP goes the moment a decision is made, approve or reject (UU PDP
  27/2022). By the time this runs the column is already null and the decision
  committed, so a failure here cannot undo either - it is logged loudly with the
  key, for a human to remove the file by hand.
*/
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

/*
  A registration predates the school it asks for, so none of this has a school
  scope. The three models it writes or reads beyond SchoolRegistration -
  SchoolMembership, School and ApprovalAudit - are why it runs unscoped.
*/
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

        await assertHoldsNoMembership(
            userId,
            'You already belong to a school, or have asked to join one'
        );

        /*
          One answer whether a School holds the NPSN or another registration is
          waiting on it, and never which school: the ticket forbids revealing it.
        */
        const npsnTaken =
            (await prisma.school.findUnique({ where: { npsn: body.npsn }, select: { id: true } })) ??
            (await prisma.schoolRegistration.findFirst({
                where: { npsn: body.npsn, status: 'PENDING' },
                select: { id: true },
            }));
        if (npsnTaken) throw conflict('This NPSN is already registered or under review');

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

/*
  The filters, as one where clause.

  `q` is a contains match, case-insensitive, over the five fields an admin might
  half-remember - including two that live on the applicant, reached through the
  relation rather than by fetching everybody and sifting in JavaScript.

  Postgres cannot use a btree index for `contains`, so this is a sequential scan
  by design. At the scale of "schools applying to one platform" that is the right
  trade: a trigram index would cost writes on every registration to speed up a
  screen one person opens. Revisit it if the queue ever reaches six figures.
*/
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

    /*
      Only an approved registration has a school, so either value of this implies
      APPROVED: `true` is "switched off", `false` is "still running". A PENDING
      row matches neither, which is the honest answer - there is nothing to be
      deactivated yet.
    */
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

/*
  One page of the queue, the number of rows behind that page, and the per-status
  totals the tab badges are made of.

  The counts are deliberately NOT filtered. A badge that shrinks as the admin
  types stops answering the question they opened the page to ask - is there work
  waiting - and the frontend says so in its own comments. `total` is the filtered
  number, for "37 results".

  Oldest first by default: a queue is worked from the front.
*/
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

/*
  Claiming the row with updateMany({ status: 'PENDING' }) inside the
  transaction is what makes a decision happen once. Two admins clicking at the
  same moment both pass assertDecidable() on their earlier read; only one of
  them can move the row out of PENDING, and the other gets the same 409.
*/
async function claimPending(tx, id, data) {
    const claimed = await tx.schoolRegistration.updateMany({
        where: { id, status: 'PENDING' },
        data,
    });
    if (claimed.count === 0) throw conflict('This school registration has already been decided');
}

/*
  Approval founds the school. In one transaction: the School with its code, the
  applicant's ACTIVE membership, their ACTIVE PRINCIPAL role - nobody else could
  have approved the first Principal - the decision on the registration, and the
  audit row. The KTP is removed only after all of that has committed.

  The applicant's current token carries no school. Their next /refresh rebuilds
  the claims (auth.service.js buildAuthClaims) and picks the school up.
*/
async function approveRegistration(id, { adminId, adminUserId }) {
    return runUnscoped('a platform admin founding a school', async () => {
        const registration = await loadRegistration(id);
        assertDecidable(registration.status, 'school registration');

        const applicant = await prisma.user.findUnique({
            where: { id: registration.applicantUserId },
            select: { deletedAt: true },
        });
        if (!applicant || applicant.deletedAt) throw conflict('The applicant account no longer exists');

        await assertHoldsNoMembership(
            registration.applicantUserId,
            'The applicant already belongs to a school, or has asked to join one'
        );

        const schoolCode = await generateSchoolCode();
        const now = new Date();

        const school = await prisma.$transaction(async (tx) => {
            await claimPending(tx, id, {
                status: 'APPROVED',
                reviewedByAdminId: adminId,
                reviewedAt: now,
                ktpVerifiedAt: now,
                ktpStoragePath: null,
            });

            const created = await tx.school.create({
                data: {
                    npsn: registration.npsn,
                    name: registration.schoolName,
                    schoolType: registration.schoolType,
                    durationYears:
                        registration.durationYears ??
                        SCHOOL_TYPES[registration.schoolType].defaultDurationYears,
                    city: registration.city,
                    schoolCode,
                },
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
        log.success(`School founded: ${school.name} (${school.npsn}), code ${school.schoolCode}`);

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
// Withdrawing a school's access - and giving it back
// ---------------------------------------------------------------------------

/*
  Deactivation, keyed by the registration because that is the row the admin is
  looking at. Only an APPROVED one has a school to switch off.

  What it does, and does not do:
  - `School.deactivatedAt` is set, with the reason and the admin who decided.
    buildAuthClaims() then issues no school claims to any member, so their tokens
    carry no schoolId and every tenant-owned query is out of reach; the School
    Code stops resolving for new joins.
  - Live sessions are cut, because an access token is minted from a refresh token:
    leaving those alone would let a member renew their way back in for up to
    fourteen days. Revoking them means the school is gone at the next refresh -
    within one access-token lifetime (JWT_ACCESS_TTL, 15 minutes by default) for
    somebody holding a valid one right now.
  - **Nothing is deleted, and no membership changes.** Ending memberships is
    leaving, which is ADR-0004 and ticket 06; a school that comes back should find
    its people still in it.
*/
async function deactivateSchool(id, { adminId, adminUserId, reason }) {
    assertRejectionReason('DEACTIVATE', reason);
    const trimmed = reason.trim();

    return runUnscoped('a platform admin withdrawing a whole school access', async () => {
        const registration = await loadRegistration(id);

        if (registration.status !== 'APPROVED' || !registration.createdSchoolId) {
            throw conflict('Only an approved registration has a school to deactivate', {
                status: registration.status,
            });
        }
        if (registration.createdSchool?.deactivatedAt) {
            throw conflict('This school is already deactivated');
        }

        const schoolId = registration.createdSchoolId;
        const now = new Date();

        const cutSessions = await prisma.$transaction(async (tx) => {
            // Claimed the same way a registration decision is: two admins clicking
            // together both pass the read above, and only one moves the row.
            const claimed = await tx.school.updateMany({
                where: { id: schoolId, deactivatedAt: null },
                data: {
                    deactivatedAt: now,
                    deactivationReason: trimmed,
                    deactivatedByAdminId: adminId,
                },
            });
            if (claimed.count === 0) throw conflict('This school is already deactivated');

            const members = await tx.schoolMembership.findMany({
                where: { schoolId, status: 'ACTIVE' },
                select: { userId: true },
            });
            const userIds = [...new Set(members.map((entry) => entry.userId))];

            const revoked =
                userIds.length > 0
                    ? await tx.refreshToken.updateMany({
                          where: { userId: { in: userIds }, revokedAt: null },
                          data: { revokedAt: now },
                      })
                    : { count: 0 };

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
            `School deactivated: ${registration.schoolName} (${registration.npsn}) - ` +
                `${cutSessions} session(s) revoked. Reason: ${trimmed}`
        );

        return getRegistration(id);
    });
}

/*
  The way back. The frontend has no button for it yet, and it exists anyway: a
  school switched off by a misclick would otherwise need the database edited by
  hand. The note is optional - there is nobody waiting to be told why their access
  came back - but it is recorded when given.

  Members have to sign in again: their refresh tokens were revoked on the way out,
  and reactivating does not un-revoke them. That is deliberate. A revoked token
  coming back to life is exactly the shape of a replay, and auth.service.js treats
  it as theft.
*/
async function reactivateSchool(id, { adminUserId, reason }) {
    const note = reason?.trim() ? reason.trim() : null;

    return runUnscoped('a platform admin restoring a school access', async () => {
        const registration = await loadRegistration(id);

        if (!registration.createdSchoolId) throw notFound('This registration has no school');
        if (!registration.createdSchool?.deactivatedAt) {
            throw conflict('This school is not deactivated');
        }

        const schoolId = registration.createdSchoolId;

        await prisma.$transaction(async (tx) => {
            const claimed = await tx.school.updateMany({
                where: { id: schoolId, deactivatedAt: { not: null } },
                data: {
                    deactivatedAt: null,
                    deactivationReason: null,
                    deactivatedByAdminId: null,
                },
            });
            if (claimed.count === 0) throw conflict('This school is not deactivated');

            /*
              The reason is cleared from the row, not from the record: why a school
              was switched off lives in ApprovalAudit, which is append-only
              (ADR-0003). Leaving a stale reason on a running school would be worse
              than losing it - it reads as current.
            */
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

        log.success(`School reactivated: ${registration.schoolName} (${registration.npsn})`);

        return getRegistration(id);
    });
}

// ---------------------------------------------------------------------------
// Principal - the School Code
// ---------------------------------------------------------------------------

/*
  School Code rotation (ticket 06). The mitigation that makes ADR-0002's join-code
  model defensible: once a code has spread beyond the people it was meant for,
  the Principal replaces it.

  - The old code stops resolving at once: resolveSchool() looks the code up by
    unique value, and nothing else remembers it.
  - Requests already PENDING are untouched. They name the school by id; the code
    only located it, and they are past that.
  - A deactivated school cannot rotate. Its members' tokens stop carrying the
    school at the next refresh, and one still in flight is refused here, since a
    code that resolves nowhere has nothing worth replacing.

  Principal checked against the database rather than the token's roles, the way
  guards.js reads status - a role withdrawn minutes ago must not still work.
*/
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

export {
    CODE_ALPHABET,
    CODE_LENGTH,
    submitRegistration,
    listMine,
    listRegistrations,
    getRegistration,
    readKtp,
    approveRegistration,
    rejectRegistration,
    deactivateSchool,
    reactivateSchool,
    rotateSchoolCode,
};
