import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
import { isPrincipal } from '../../shared/guards.js';
import { recordAudit } from '../../shared/approval.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { holidaySource } from './holidays.source.js';

const log = createLogger('Holidays');

// Holidays (teaching-and-learning ticket 08): no Session is generated on one.
//
// Three kinds of day off, owned by two people:
// - NATIONAL holidays and JOINT_LEAVE (cuti bersama), the government's list, kept
//   by the Platform Admin. Fetched as DRAFTs from a community source and counting
//   only once an admin confirms them - there is no official API.
// - Joint leave counts at a school only if its Principal says the school observes
//   it (School.observesJointLeave): regional education calendars differ.
// - A school's own holidays, set by its Principal.
//
// Nothing is deleted: a day taken back is WITHDRAWN, or gets withdrawnAt.
//
// Owed to ticket 02: a holiday that starts counting after a Semester has started
// must cancel the Sessions on it (no other number changing). Session does not
// exist yet; confirmNational, addNational, addSchoolHoliday, setJointLeave and
// setJointLeaveDay are where that call goes.

const NATIONAL_SUBJECT = 'NationalHoliday';
const SCHOOL_HOLIDAY_SUBJECT = 'SchoolHoliday';
const SCHOOL_SUBJECT = 'School';

// Dates are @db.Date: stored as midnight UTC, read back as the calendar day.
const toDate = (day) => new Date(`${day}T00:00:00Z`);
const toDay = (value) => value.toISOString().slice(0, 10);
const yearRange = (year) => ({ gte: toDate(`${year}-01-01`), lte: toDate(`${year}-12-31`) });

const nationalView = (row) => ({
    id: row.id,
    date: toDay(row.date),
    name: row.name,
    kind: row.kind,
    status: row.status,
    source: row.source,
    confirmedAt: row.confirmedAt,
    withdrawnAt: row.withdrawnAt,
});

const schoolHolidayView = (row) => ({
    id: row.id,
    startDate: toDay(row.startDate),
    endDate: toDay(row.endDate),
    name: row.name,
    withdrawnAt: row.withdrawnAt,
});

// Audit rows about the national calendar belong to no school; the admin's token
// opens no school scope, so they are written unscoped.
const auditNational = (entry) =>
    runUnscoped('auditing the national holiday calendar', async () => await recordAudit(entry));

// ---------------------------------------------------------------------------
// The Platform Admin's national calendar
// ---------------------------------------------------------------------------

// Every status, so the admin sees drafts waiting and what was withdrawn.
async function listNational(year) {
    const rows = await prisma.nationalHoliday.findMany({
        where: { date: yearRange(year) },
        orderBy: [{ date: 'asc' }, { name: 'asc' }],
    });
    return rows.map(nationalView);
}

// A year's drafts from the community source. A day the source already gave - same
// date, same name as the SOURCE wrote it (`sourceName`) - is not added again, in
// any status: fetching twice changes nothing, a withdrawal is not undone, and an
// admin's correction of a draft's name is not answered by the original coming
// back as a new draft beside it. skipDuplicates also covers a hand-added day of
// the same date and name.
async function fetchDrafts(year) {
    const entries = await holidaySource.fetchYear(year);

    const known = await prisma.nationalHoliday.findMany({
        where: { date: yearRange(year), sourceName: { not: null } },
        select: { date: true, sourceName: true },
    });
    const seen = new Set(known.map((row) => `${toDay(row.date)}|${row.sourceName}`));
    const fresh = entries.filter((entry) => !seen.has(`${entry.date}|${entry.name}`));

    const { count } = await prisma.nationalHoliday.createMany({
        data: fresh.map((entry) => ({
            date: toDate(entry.date),
            name: entry.name,
            sourceName: entry.name,
            kind: entry.kind,
            source: holidaySource.name,
        })),
        skipDuplicates: true,
    });

    log.info(`Holiday drafts for ${year}: ${entries.length} fetched, ${count} new`);
    return { fetched: entries.length, added: count, holidays: await listNational(year) };
}

// Added by hand, it is confirmed as written: the admin is the one who checked.
async function addNational({ date, name, kind }, { adminId, adminUserId }) {
    const now = new Date();
    const created = await prisma.nationalHoliday.create({
        data: {
            date: toDate(date),
            name,
            kind,
            source: 'manual',
            status: 'CONFIRMED',
            confirmedByAdminId: adminId,
            confirmedAt: now,
        },
    });
    await auditNational({
        subjectType: NATIONAL_SUBJECT,
        subjectId: created.id,
        action: 'APPROVE',
        actorUserId: adminUserId,
    });

    log.info(`National holiday added: ${date} ${name}`);
    return nationalView(created);
}

// Only a draft is corrected. A confirmed day may already be keeping Sessions from
// being generated, so it is withdrawn and added again instead.
async function updateDraft(id, changes) {
    const existing = await prisma.nationalHoliday.findUnique({ where: { id } });
    if (!existing) throw notFound('Holiday not found');

    const updated = await prisma.nationalHoliday.updateMany({
        where: { id, status: 'DRAFT' },
        data: {
            ...(changes.date ? { date: toDate(changes.date) } : {}),
            ...(changes.name ? { name: changes.name } : {}),
            ...(changes.kind ? { kind: changes.kind } : {}),
        },
    });
    if (updated.count === 0) {
        throw conflict('Only a draft can be corrected. Withdraw a confirmed holiday and add it again');
    }

    return nationalView(await prisma.nationalHoliday.findUnique({ where: { id } }));
}

// Confirming drafts, each claimed with updateMany({ status: 'DRAFT' }) so two
// admins confirming together audit each day once. An id that is not a draft is
// reported back, not an error: the rest still go through.
async function confirmNational(ids, { adminId, adminUserId }) {
    const now = new Date();
    const confirmed = [];
    const skipped = [];

    for (const id of [...new Set(ids)]) {
        const claimed = await prisma.nationalHoliday.updateMany({
            where: { id, status: 'DRAFT' },
            data: { status: 'CONFIRMED', confirmedByAdminId: adminId, confirmedAt: now },
        });
        if (claimed.count === 0) {
            skipped.push(id);
            continue;
        }
        await auditNational({
            subjectType: NATIONAL_SUBJECT,
            subjectId: id,
            action: 'APPROVE',
            actorUserId: adminUserId,
        });
        confirmed.push(id);
    }

    log.info(`National holidays confirmed: ${confirmed.length}, skipped ${skipped.length}`);
    return { confirmed, skipped };
}

// A draft or a confirmed day taken back. It stays on file as WITHDRAWN, and a
// Session a confirmed one already kept from being generated does not come back:
// a schedule is fixed once its Semester has started (ticket 02).
async function withdrawNational(id, { adminUserId }) {
    const claimed = await prisma.nationalHoliday.updateMany({
        where: { id, status: { in: ['DRAFT', 'CONFIRMED'] } },
        data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
    });
    if (claimed.count === 0) {
        const exists = await prisma.nationalHoliday.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw notFound('Holiday not found');
        throw conflict('This holiday is already withdrawn');
    }
    await auditNational({
        subjectType: NATIONAL_SUBJECT,
        subjectId: id,
        action: 'WITHDRAW',
        actorUserId: adminUserId,
    });

    return nationalView(await prisma.nationalHoliday.findUnique({ where: { id } }));
}

// ---------------------------------------------------------------------------
// A school's calendar
// ---------------------------------------------------------------------------

async function assertPrincipal(auth) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden('Only the Principal can do this');
}

// Whether a school is off on a confirmed national day. A national holiday always;
// a joint-leave day by the school's choice for that day, or - with none made, or
// set back to null - by the school's default (owner, 2026-09-27: a Principal may
// take some joint-leave days and not others).
const observedFor = (kind, choice, schoolDefault) =>
    kind === 'NATIONAL' || (choice ?? schoolDefault);

// This school's per-day choices for the given national days, by holiday id.
async function choicesFor(holidayIds) {
    if (holidayIds.length === 0) return new Map();
    const rows = await prisma.schoolJointLeaveChoice.findMany({
        where: { nationalHolidayId: { in: holidayIds } },
        select: { nationalHolidayId: true, observed: true },
    });
    return new Map(rows.map((row) => [row.nationalHolidayId, row.observed]));
}

// What every member of the school reads for a year: the confirmed national days,
// each joint-leave day marked with whether this school observes it - and whether
// that is a choice for the day or the school's default - and the school's own
// holidays still standing.
async function calendar(auth, year) {
    const school = await prisma.school.findUnique({
        where: { id: auth.schoolId },
        select: { observesJointLeave: true },
    });
    const national = await prisma.nationalHoliday.findMany({
        where: { status: 'CONFIRMED', date: yearRange(year) },
        orderBy: { date: 'asc' },
    });
    const choices = await choicesFor(national.map((row) => row.id));
    const own = await prisma.schoolHoliday.findMany({
        where: {
            withdrawnAt: null,
            startDate: { lte: toDate(`${year}-12-31`) },
            endDate: { gte: toDate(`${year}-01-01`) },
        },
        orderBy: { startDate: 'asc' },
    });

    return {
        observesJointLeave: school.observesJointLeave,
        national: national.map((row) => {
            const choice = row.kind === 'JOINT_LEAVE' ? (choices.get(row.id) ?? null) : null;
            return {
                id: row.id,
                date: toDay(row.date),
                name: row.name,
                kind: row.kind,
                observed: observedFor(row.kind, choice, school.observesJointLeave),
                // true / false: chosen for this day; null: the school's default.
                choice,
            };
        }),
        school: own.map(schoolHolidayView),
    };
}

async function addSchoolHoliday(auth, { startDate, endDate, name }) {
    await assertPrincipal(auth);

    const created = await prisma.$transaction(async (tx) => {
        const row = await tx.schoolHoliday.create({
            data: {
                startDate: toDate(startDate),
                endDate: toDate(endDate),
                name,
                createdByUserId: auth.userId,
            },
        });
        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: SCHOOL_HOLIDAY_SUBJECT,
            subjectId: row.id,
            action: 'APPROVE',
            actorUserId: auth.userId,
            client: tx,
        });
        return row;
    });

    log.info(`School holiday added at ${auth.schoolName}: ${startDate}..${endDate} ${name}`);
    return schoolHolidayView(created);
}

async function withdrawSchoolHoliday(auth, id) {
    await assertPrincipal(auth);

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.schoolHoliday.updateMany({
            where: { id, withdrawnAt: null },
            data: { withdrawnAt: new Date(), withdrawnByUserId: auth.userId },
        });
        // Another school's, an unknown id, or one already withdrawn: one answer.
        if (claimed.count === 0) throw notFound('No school holiday of yours stands under that id');

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: SCHOOL_HOLIDAY_SUBJECT,
            subjectId: id,
            action: 'WITHDRAW',
            actorUserId: auth.userId,
            client: tx,
        });
    });

    return schoolHolidayView(await prisma.schoolHoliday.findFirst({ where: { id } }));
}

// The Principal's switch for joint leave. Audited only when it changes.
async function setJointLeave(auth, { observesJointLeave }) {
    await assertPrincipal(auth);

    await prisma.$transaction(async (tx) => {
        const before = await tx.school.findUnique({
            where: { id: auth.schoolId },
            select: { observesJointLeave: true },
        });
        const claimed = await tx.school.updateMany({
            where: { id: auth.schoolId, deactivatedAt: null },
            data: { observesJointLeave },
        });
        if (!before || claimed.count === 0) throw notFound('School not found');

        if (before.observesJointLeave !== observesJointLeave) {
            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: SCHOOL_SUBJECT,
                subjectId: auth.schoolId,
                action: 'UPDATE_JOINT_LEAVE',
                actorUserId: auth.userId,
                reason: observesJointLeave ? 'Joint leave now observed' : 'Joint leave no longer observed',
                client: tx,
            });
        }
    });

    log.info(`Joint leave ${observesJointLeave ? 'observed' : 'not observed'} at ${auth.schoolName}`);
    return { observesJointLeave };
}

// The Principal's choice for one joint-leave day: true (off), false (in school),
// or null (follow the school's default again). Read, then written, inside one
// transaction: an upsert cannot take the tenant extension's extra schoolId filter
// on its unique where. Audited only when the choice changes.
async function setJointLeaveDay(auth, holidayId, { observed }) {
    await assertPrincipal(auth);

    const holiday = await prisma.nationalHoliday.findUnique({ where: { id: holidayId } });
    if (!holiday) throw notFound('Holiday not found');
    if (holiday.kind !== 'JOINT_LEAVE') {
        throw badRequest('Only a joint-leave day can be chosen. A national holiday is always off');
    }
    if (holiday.status !== 'CONFIRMED') {
        throw conflict('Only a confirmed joint-leave day can be chosen');
    }

    await prisma.$transaction(async (tx) => {
        const existing = await tx.schoolJointLeaveChoice.findFirst({
            where: { nationalHolidayId: holidayId },
        });
        const before = existing?.observed ?? null;
        if (existing) {
            await tx.schoolJointLeaveChoice.updateMany({
                where: { id: existing.id },
                data: { observed, decidedByUserId: auth.userId },
            });
        } else {
            await tx.schoolJointLeaveChoice.create({
                data: { nationalHolidayId: holidayId, observed, decidedByUserId: auth.userId },
            });
        }

        if (before !== observed) {
            const said =
                observed === null
                    ? "back to the school's default"
                    : observed
                        ? 'observed'
                        : 'not observed';
            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: SCHOOL_SUBJECT,
                subjectId: auth.schoolId,
                action: 'UPDATE_JOINT_LEAVE',
                actorUserId: auth.userId,
                reason: `${toDay(holiday.date)} ${holiday.name}: ${said}`,
                client: tx,
            });
        }
    });

    const school = await prisma.school.findUnique({
        where: { id: auth.schoolId },
        select: { observesJointLeave: true },
    });
    log.info(`Joint leave ${toDay(holiday.date)} set to ${observed} at ${auth.schoolName}`);
    return {
        id: holiday.id,
        date: toDay(holiday.date),
        name: holiday.name,
        choice: observed,
        observed: observedFor(holiday.kind, observed, school.observesJointLeave),
    };
}

// ---------------------------------------------------------------------------
// For ticket 02: which days a school is off
// ---------------------------------------------------------------------------

// Every day from `from` to `to` ('YYYY-MM-DD', inclusive) the school is off, as a
// Set of 'YYYY-MM-DD'. Confirmed national holidays always; a joint-leave day by the
// school's choice for it, else its default; the school's own standing holidays.
// Runs inside the school's scope - SchoolHoliday and the choices are tenant-owned.
async function holidayDatesBetween(schoolId, from, to) {
    const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { observesJointLeave: true },
    });
    const national = await prisma.nationalHoliday.findMany({
        where: { status: 'CONFIRMED', date: { gte: toDate(from), lte: toDate(to) } },
        select: { id: true, date: true, kind: true },
    });
    const choices = await choicesFor(national.map((row) => row.id));
    const own = await prisma.schoolHoliday.findMany({
        where: { withdrawnAt: null, startDate: { lte: toDate(to) }, endDate: { gte: toDate(from) } },
        select: { startDate: true, endDate: true },
    });

    const days = new Set(
        national
            .filter((row) => observedFor(row.kind, choices.get(row.id) ?? null, school.observesJointLeave))
            .map((row) => toDay(row.date))
    );
    const DAY = 24 * 60 * 60 * 1000;
    for (const { startDate, endDate } of own) {
        for (let at = startDate.getTime(); at <= endDate.getTime(); at += DAY) {
            const day = toDay(new Date(at));
            if (day >= from && day <= to) days.add(day);
        }
    }
    return days;
}

export {
    listNational,
    fetchDrafts,
    addNational,
    updateDraft,
    confirmNational,
    withdrawNational,
    calendar,
    addSchoolHoliday,
    withdrawSchoolHoliday,
    setJointLeave,
    setJointLeaveDay,
    holidayDatesBetween,
};
