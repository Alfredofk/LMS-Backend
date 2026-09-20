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
import { AppError, conflict, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('School');

const SUBJECT_TYPE = 'SchoolRegistration';
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
    school: registration.createdSchool
        ? {
              id: registration.createdSchool.id,
              name: registration.createdSchool.name,
              schoolCode: registration.createdSchool.schoolCode,
          }
        : null,
});

const applicantSelect = { select: { id: true, email: true, fullName: true } };
const createdSchoolSelect = { select: { id: true, name: true, schoolCode: true } };

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

// Oldest first: a queue is worked from the front.
async function listRegistrations({ status }) {
    const registrations = await prisma.schoolRegistration.findMany({
        where: { status },
        include: { applicant: applicantSelect },
        orderBy: { createdAt: 'asc' },
    });
    return registrations.map(adminView);
}

async function loadRegistration(id) {
    const registration = await prisma.schoolRegistration.findUnique({
        where: { id },
        include: { applicant: applicantSelect },
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
};
