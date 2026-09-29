import { prisma } from '../../shared/prisma.js';

// Reading the holiday calendar: which days a school is off (teaching-and-learning
// tickets 08 and 02). Its own file so the sessions module can read it, and the
// holidays service can tell the sessions module the calendar changed, without the
// two services importing each other.

const DAY = 24 * 60 * 60 * 1000;

// Dates are @db.Date: stored as midnight UTC, read back as the calendar day.
const toDate = (day) => new Date(`${day}T00:00:00Z`);
const toDay = (value) => value.toISOString().slice(0, 10);

// Whether a school is off on a confirmed national day. A national holiday always;
// a joint-leave day by the school's choice for that day, or - with none made, or
// set back to null - by the school's default (owner, 2026-09-27: a Principal may
// take some joint-leave days and not others).
const observedFor = (kind, choice, schoolDefault) =>
    kind === 'NATIONAL' || (choice ?? schoolDefault);

// This school's per-day choices for the given national days, by holiday id. Runs
// inside the school's scope.
async function choicesFor(holidayIds) {
    if (holidayIds.length === 0) return new Map();
    const rows = await prisma.schoolJointLeaveChoice.findMany({
        where: { nationalHolidayId: { in: holidayIds } },
        select: { nationalHolidayId: true, observed: true },
    });
    return new Map(rows.map((row) => [row.nationalHolidayId, row.observed]));
}

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
    for (const { startDate, endDate } of own) {
        for (let at = startDate.getTime(); at <= endDate.getTime(); at += DAY) {
            const day = toDay(new Date(at));
            if (day >= from && day <= to) days.add(day);
        }
    }
    return days;
}

// Every calendar day from `from` to `to`, inclusive, as 'YYYY-MM-DD'.
function daysBetween(from, to) {
    const days = [];
    for (let at = toDate(from).getTime(); at <= toDate(to).getTime(); at += DAY) {
        days.push(toDay(new Date(at)));
    }
    return days;
}

export { toDate, toDay, observedFor, choicesFor, holidayDatesBetween, daysBetween };
