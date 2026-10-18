import { prisma } from '../../shared/prisma.js';

// Reading the holiday calendar: which days a school is off (teaching-and-learning
// tickets 08 and 02), and which days an Exam Week keeps a grade level from teaching
// (ticket 13). Its own file so the sessions and assessment modules can read it, and
// the holidays service can tell the sessions module the calendar changed, without
// the services importing each other.

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
    for (const run of own) addRun(days, run, from, to);
    return days;
}

// The Exam Weeks standing in a Semester for one grade level (ticket 13), oldest
// first; `where` narrows them further, to a type or to some days. Runs inside the
// school's scope.
const examWeeksFor = (semesterId, gradeLevel, where = {}) =>
    prisma.examWeek.findMany({
        where: { ...where, semesterId, withdrawnAt: null, gradeLevels: { has: gradeLevel } },
        orderBy: { startDate: 'asc' },
    });

// Every day from `from` to `to` ('YYYY-MM-DD', inclusive) an Exam Week keeps the
// Classes of one grade level from teaching in a Semester, as a Set of 'YYYY-MM-DD'.
// The other grade levels are taught on them (owner, 2026-10-18).
async function examWeekDatesBetween(semesterId, gradeLevel, from, to) {
    const weeks = await examWeeksFor(semesterId, gradeLevel, {
        startDate: { lte: toDate(to) },
        endDate: { gte: toDate(from) },
    });
    const days = new Set();
    for (const week of weeks) addRun(days, week, from, to);
    return days;
}

// Each day of a stored run of days (@db.Date) that falls from `from` to `to`, added
// to `days`.
function addRun(days, { startDate, endDate }, from, to) {
    for (let at = startDate.getTime(); at <= endDate.getTime(); at += DAY) {
        const day = toDay(new Date(at));
        if (day >= from && day <= to) days.add(day);
    }
}

// Every calendar day from `from` to `to`, inclusive, as 'YYYY-MM-DD'.
function daysBetween(from, to) {
    const days = [];
    for (let at = toDate(from).getTime(); at <= toDate(to).getTime(); at += DAY) {
        days.push(toDay(new Date(at)));
    }
    return days;
}

export {
    toDate,
    toDay,
    observedFor,
    choicesFor,
    holidayDatesBetween,
    examWeeksFor,
    examWeekDatesBetween,
    daysBetween,
};
