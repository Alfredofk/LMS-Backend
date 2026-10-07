import { prisma } from '../../shared/prisma.js';
import { runInSchool } from '../../shared/tenantContext.js';
import { isPrincipalOrVice, isHomeroomOf, placementsOf } from '../../shared/guards.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { localToUtc, utcToLocal } from '../../shared/timeZone.js';
import { createLogger } from '../../lib/helpers.js';
import { toDate, toDay, holidayDatesBetween, daysBetween } from '../holidays/holidays.calendar.js';
import { moveContentOffHoliday } from '../content/content.moves.js';
import { summaryBySessionOf } from '../content/content.summary.js';

const log = createLogger('Sessions');

// The weekly timetable and the Sessions it makes (teaching-and-learning ticket 02).
//
// - A ClassSubject's schedule is a set of weekly slots in the SCHOOL's time zone,
//   set by the Principal or a Vice Principal. The school sets the timetable; the
//   system shows no substitutes (owner, 2026-09-27).
// - From it every Session of the Semester is generated, skipping holidays, and
//   numbered: "Pertemuan ke-1, ke-2, ...".
// - Before the Semester starts the schedule may change, and so may the calendar:
//   either way the Sessions are planned again, each number moving to its new date
//   and keeping its Content. A number no longer reached is CANCELLED, never deleted.
// - After the start the timetable, the Semester's dates and the school's time zone
//   still change (ticket 09, owner 2026-09-28), but a Session already past is never
//   touched. What is planned again runs from tomorrow, the school's local date, and
//   its numbers continue after the last one before it; today's stay as they are.
// - A holiday that starts counting after the start cancels the Sessions on it, and
//   no other number changes; their Content moves to the next SCHEDULED Session
//   (content.moves.js, ticket 04). One taken back after the start re-plans from
//   tomorrow, so its day has Sessions again, empty (owner, 2026-09-29).
// - A teacher who leaves mid-semester hands the rest to whoever takes the slot:
//   the successor's ClassSubject inherits the schedule and the future Sessions. So
//   does an assignment ended or replaced while its teacher stays (ticket 10),
//   unless the subject stops: then the Sessions ahead are cancelled.
// - A timetable set for the first time after the start, or a start date moved back,
//   plans the Semester from its first day all the same. Each Session that lands
//   before tomorrow needs completion: its teacher answers that it never happened, or
//   that it did by confirming its attendance (ticket 09, owner 2026-09-29; ticket 03,
//   owner 2026-09-30). A successor answers for what an ended ClassSubject left.

const MINUTES_PER_HOUR = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
// Check-in opens this long before a Session starts (owner, 2026-10-08).
const CHECK_IN_EARLY_MS = 30 * 60 * 1000;

const toMinute = (hhmm) => {
    const [hours, minutes] = hhmm.split(':').map(Number);
    return hours * MINUTES_PER_HOUR + minutes;
};
const pad = (value) => String(value).padStart(2, '0');
const toHhmm = (minute) =>
    `${pad(Math.floor(minute / MINUTES_PER_HOUR))}:${pad(minute % MINUTES_PER_HOUR)}`;

// ISO day of the week of a calendar day: 1 Monday ... 7 Sunday.
const isoDayOf = (day) => toDate(day).getUTCDay() || 7;

const overlaps = (a, b) =>
    a.dayOfWeek === b.dayOfWeek && a.startMinute < b.endMinute && b.startMinute < a.endMinute;

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const describeSlot = (slot) =>
    `${DAY_NAMES[slot.dayOfWeek]} ${toHhmm(slot.startMinute)}-${toHhmm(slot.endMinute)}`;

const classSubjectSelect = {
    id: true,
    status: true,
    endedAt: true,
    classId: true,
    subjectId: true,
    semesterId: true,
    teacherMembershipId: true,
    class: { select: { name: true, homeroomTeacherMembershipId: true } },
    subject: { select: { code: true, name: true } },
    semester: {
        select: {
            id: true,
            ordinal: true,
            status: true,
            startDate: true,
            endDate: true,
            academicYear: { select: { label: true, status: true } },
        },
    },
    scheduleSlots: {
        where: { replacedAt: null },
        select: { dayOfWeek: true, startMinute: true, endMinute: true },
        orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    },
};

async function loadClassSubject(id) {
    const row = await prisma.classSubject.findFirst({ where: { id }, select: classSubjectSelect });
    if (!row) throw notFound('Class subject not found');
    return row;
}

// School is above tenancy, so this reads without a scope.
async function zoneOf(schoolId) {
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { timeZone: true } });
    return school?.timeZone ?? null;
}

// A Semester starts at 00:00 of its first day, in the school's zone.
const midnightOf = (day, zone) => localToUtc(day, '00:00', zone);
const startOf = (semester, zone) => midnightOf(toDay(semester.startDate), zone);
const hasStarted = (semester, zone, now = new Date()) => now >= startOf(semester, zone);

const nextDay = (day) => toDay(new Date(toDate(day).getTime() + DAY_MS));

// The school's local date tomorrow: the first day a change made now reaches once
// the Semester has started (ticket 09).
const tomorrowOf = (zone, now = new Date()) => nextDay(utcToLocal(now, zone).date);

// The first local date a timetable change made now would affect: the Semester's
// first day before it starts, tomorrow after.
const replansFrom = (semester, zone, now = new Date()) =>
    hasStarted(semester, zone, now) ? tomorrowOf(zone, now) : toDay(semester.startDate);

// The moments a Semester spans in the school's own zone: from 00:00 of its first
// day to 00:00 after its last (2026-10-04, for the progress views' roster). A
// school with no time zone has no Session either; UTC midnight stands in.
async function semesterSpan(schoolId, semester) {
    const zone = await zoneOf(schoolId);
    const after = nextDay(toDay(semester.endDate));
    return zone
        ? { start: startOf(semester, zone), end: midnightOf(after, zone) }
        : { start: toDate(toDay(semester.startDate)), end: toDate(after) };
}

// The school's local date today, as YYYY-MM-DD; for a school with no time zone, which
// has no Session either, the UTC date, as semesterSpan does. Closing a year reads it
// (registration-and-membership 24).
async function todayOf(schoolId, now = new Date()) {
    const zone = await zoneOf(schoolId);
    return zone ? utcToLocal(now, zone).date : toDay(now);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

// The ClassSubjects whose Sessions follow a change to the calendar or the
// Semester's dates: the live ones with a timetable, and one whose teacher left but
// still holds the Sessions ahead, waiting for a successor to inherit them (owner,
// 2026-09-29). Skipped, those would reach the successor out of date - still on a
// day that became a holiday, or past the Semester's new end. Once inherited, the
// ended one holds nothing ahead and drops out.
const plannedHere = (now) => ({
    status: 'ACTIVE',
    scheduleSlots: { some: { replacedAt: null } },
    OR: [{ endedAt: null }, { sessions: { some: { startsAt: { gt: now } } } }],
});

// What planning one ClassSubject needs: its school, the zone its slots are read in,
// its Semester's dates, and the slots themselves.
const targetOf = (schoolId, zone, classSubject, slots = classSubject.scheduleSlots) => ({
    schoolId,
    zone,
    semester: classSubject.semester,
    classSubjectId: classSubject.id,
    slots,
});

// Every Session the slots make, from `fromDay` to the Semester's last day,
// skipping the school's holidays, oldest first.
async function plan({ schoolId, zone, semester, slots }, fromDay) {
    const lastDay = toDay(semester.endDate);
    if (slots.length === 0 || fromDay > lastDay) return [];

    const holidays = await holidayDatesBetween(schoolId, fromDay, lastDay);
    const planned = [];
    for (const day of daysBetween(fromDay, lastDay)) {
        if (holidays.has(day)) continue;
        const dayOfWeek = isoDayOf(day);
        for (const slot of slots) {
            if (slot.dayOfWeek !== dayOfWeek) continue;
            planned.push({
                startsAt: localToUtc(day, toHhmm(slot.startMinute), zone),
                endsAt: localToUtc(day, toHhmm(slot.endMinute), zone),
            });
        }
    }
    return planned.sort((a, b) => a.startsAt - b.startsAt);
}

// The plan written onto numbers firstNumber.., in date order: an existing number
// moves to its new date and is SCHEDULED again (its Content goes with it), a missing
// one is created, and a number beyond the plan is CANCELLED - never deleted. A
// number below firstNumber is not touched. A Session placed before `markBefore`
// (tomorrow) is already past or about to be, so it needs completion.
async function applyPlan(tx, classSubjectId, planned, { now, markBefore, firstNumber = 1 }) {
    const existing = await tx.session.findMany({
        where: { classSubjectId },
        select: { id: true, number: true, status: true },
    });
    const byNumber = new Map(existing.map((row) => [row.number, row]));

    for (const [index, slot] of planned.entries()) {
        const number = firstNumber + index;
        const needsCompletion = slot.startsAt < markBefore;
        const row = byNumber.get(number);
        if (row) {
            await tx.session.updateMany({
                where: { id: row.id },
                data: {
                    ...slot,
                    status: 'SCHEDULED',
                    cancelReason: null,
                    cancelledAt: null,
                    needsCompletion,
                },
            });
        } else {
            await tx.session.create({ data: { classSubjectId, number, ...slot, needsCompletion } });
        }
    }

    const last = firstNumber + planned.length - 1;
    const beyond = existing.filter((row) => row.number > last && row.status !== 'CANCELLED');
    if (beyond.length > 0) {
        await tx.session.updateMany({
            where: { id: { in: beyond.map((row) => row.id) } },
            data: {
                status: 'CANCELLED',
                cancelReason: 'SCHEDULE_CHANGED',
                cancelledAt: now,
                needsCompletion: false,
            },
        });
    }
}

// The whole Semester from its first day, onto numbers 1..n: before it starts, for
// a timetable set for the first time, and when its start date moves.
async function replanWhole(tx, target, now) {
    const planned = await plan(target, toDay(target.semester.startDate));
    const markBefore = midnightOf(tomorrowOf(target.zone, now), target.zone);
    await applyPlan(tx, target.classSubjectId, planned, { now, markBefore });
    return planned.length;
}

// Where the numbers from `keepBefore` on begin: after the last Session before it
// that still holds its number - SCHEDULED, or cancelled for a holiday or as never
// held. A number cancelled because a plan stopped reaching it keeps a stale date,
// so it does not count. A successor with nothing before it carries on from the
// first number it inherited.
async function firstNumberFrom(tx, classSubjectId, keepBefore) {
    const rows = await tx.session.findMany({
        where: { classSubjectId },
        select: { number: true, startsAt: true, cancelReason: true },
    });
    const held = rows.filter((row) => row.cancelReason !== 'SCHEDULE_CHANGED');
    const before = held.filter((row) => row.startsAt < keepBefore);
    if (before.length > 0) return Math.max(...before.map((row) => row.number)) + 1;
    if (held.length > 0) return Math.min(...held.map((row) => row.number));
    return 1;
}

// After the start: planned again from tomorrow to the Semester's end. Past Sessions
// and today's keep their dates and numbers; from tomorrow the numbers continue after
// the last one before it (ticket 09, owner 2026-09-29). A number cancelled for a
// holiday that falls from tomorrow gets a new date like any other, as if the
// holiday had always been there.
async function replanAhead(tx, target, now) {
    const fromDay = tomorrowOf(target.zone, now);
    const keepBefore = midnightOf(fromDay, target.zone);
    const planned = await plan(target, fromDay);
    const firstNumber = await firstNumberFrom(tx, target.classSubjectId, keepBefore);
    await applyPlan(tx, target.classSubjectId, planned, { now, markBefore: keepBefore, firstNumber });
    return planned.length;
}

// ---------------------------------------------------------------------------
// Clashes
// ---------------------------------------------------------------------------

// The same Class, or the same teacher, busy at an overlapping time in the same
// Semester (owner, 2026-09-27). Only live ClassSubjects count: one whose teacher
// left is history, and a PENDING one has no timetable yet.
async function assertNoClash(classSubject, slots) {
    const others = await prisma.classSubject.findMany({
        where: {
            semesterId: classSubject.semesterId,
            status: 'ACTIVE',
            endedAt: null,
            id: { not: classSubject.id },
            OR: [
                { classId: classSubject.classId },
                { teacherMembershipId: classSubject.teacherMembershipId },
            ],
        },
        select: {
            classId: true,
            class: { select: { name: true } },
            subject: { select: { name: true } },
            scheduleSlots: {
                where: { replacedAt: null },
                select: { dayOfWeek: true, startMinute: true, endMinute: true },
            },
        },
    });

    for (const other of others) {
        for (const theirs of other.scheduleSlots) {
            const clash = slots.find((mine) => overlaps(mine, theirs));
            if (!clash) continue;
            const who =
                other.classId === classSubject.classId
                    ? `${classSubject.class.name} already has ${other.subject.name}`
                    : `this teacher already teaches ${other.subject.name} in ${other.class.name}`;
            throw conflict(`${describeSlot(clash)} clashes: ${who} at ${describeSlot(theirs)}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

async function assertPrincipalOrVice(auth) {
    if (!(await isPrincipalOrVice(auth.membershipId))) {
        throw forbidden('Only the Principal or a Vice Principal can set the timetable');
    }
}

// Who answers for a ClassSubject's Sessions - confirms their attendance, or says
// one never happened: its teacher while it is live. Once it has ended (the teacher
// left, or the assignment was ended or replaced), the teacher of the live
// ClassSubject in the same slot, the successor (owner, 2026-09-29, built in
// teaching-and-learning 03). With no successor yet, nobody does. A PENDING or
// REJECTED one never had Sessions.
async function answeringTeacherOf(classSubject) {
    if (classSubject.status !== 'ACTIVE') return null;
    if (classSubject.endedAt === null) return classSubject.teacherMembershipId;

    const successor = await prisma.classSubject.findFirst({
        where: {
            classId: classSubject.classId,
            subjectId: classSubject.subjectId,
            semesterId: classSubject.semesterId,
            status: 'ACTIVE',
            endedAt: null,
        },
        select: { teacherMembershipId: true },
    });
    return successor?.teacherMembershipId ?? null;
}

// What a staff member is to a ClassSubject - the one rule sessions, attendance,
// content and the progress views share (2026-10-04, from the review of
// teaching-and-learning 06):
// - 'teacher': the one who answers for it (answeringTeacherOf), who confirms its
//   attendance and manages its Content;
// - 'reader': the Principal, a Vice Principal, or the Class's homeroom teacher,
//   who read it and change nothing of it;
// - null: no standing as staff. Whether a student is placed in the Class is each
//   caller's own question.
async function staffStandingOf(auth, classSubject) {
    if ((await answeringTeacherOf(classSubject)) === auth.membershipId) return 'teacher';
    if (await isPrincipalOrVice(auth.membershipId)) return 'reader';
    if (await isHomeroomOf(auth.membershipId, classSubject.classId)) return 'reader';
    return null;
}

// Who reads a ClassSubject's timetable, Sessions and Content - the one rule this
// module and content.service.js read (2026-10-06; content had its own copy):
// - its staff, by their staffStandingOf;
// - 'student': placed in the Class now (spec invariant 6);
// - 'past-student': placed there once (teaching-and-learning 12, owner 2026-10-06).
//   They read only what began before they left: given a Session's `startsAt`, a later
//   one is not theirs. They read and do nothing - no check-in, and nothing they open
//   is tracked;
// - null: anyone else, another school included.
async function readerStandingOf(auth, classSubject, startsAt = null) {
    const staff = await staffStandingOf(auth, classSubject);
    if (staff) return staff;
    const [placed] = await placementsOf(auth.membershipId, classSubject.classId);
    if (!placed) return null;
    if (placed.leftAt === null) return 'student';
    return startsAt === null || startsAt < placed.leftAt ? 'past-student' : null;
}

// A student's standing, now or from an earlier placement: they read what is
// published, and their own progress on it.
const isStudentStanding = (standing) => standing === 'student' || standing === 'past-student';

// Anyone readerStandingOf leaves out gets the same 404 as another school's.
async function assertCanRead(auth, classSubject) {
    if (!(await readerStandingOf(auth, classSubject))) throw notFound('Class subject not found');
}

// ---------------------------------------------------------------------------
// One Session, as attendance and content read it
// ---------------------------------------------------------------------------

// A Session's ClassSubject as its readers need it: the slot and teacher that
// answeringTeacherOf reads, and the Class's name and academic year to say which
// Class it was - two years may each have a 7A. The calendars below read it too.
const sessionClassSubjectSelect = {
    id: true,
    status: true,
    endedAt: true,
    classId: true,
    subjectId: true,
    semesterId: true,
    teacherMembershipId: true,
    class: { select: { name: true, academicYear: { select: { label: true } } } },
    subject: { select: { code: true, name: true } },
};

const sessionSelect = {
    id: true,
    number: true,
    status: true,
    cancelReason: true,
    startsAt: true,
    endsAt: true,
    needsCompletion: true,
    completedAt: true,
    classSubject: { select: sessionClassSubjectSelect },
};

async function loadSession(id) {
    const session = await prisma.session.findFirst({ where: { id }, select: sessionSelect });
    if (!session) throw notFound('Session not found');
    return session;
}

// "Pertemuan ke-3 of MAT in 7A", for messages and log lines.
const describeSession = (session) =>
    `Pertemuan ke-${session.number} of ${session.classSubject.subject.code} in ${session.classSubject.class.name}`;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const slotView = (slot) => ({
    dayOfWeek: slot.dayOfWeek,
    start: toHhmm(slot.startMinute),
    end: toHhmm(slot.endMinute),
});

function sessionView(row, zone) {
    const start = utcToLocal(row.startsAt, zone);
    return {
        id: row.id,
        number: row.number,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        // The same moment in the school's own time, as a timetable reads it.
        local: {
            date: start.date,
            dayOfWeek: start.dayOfWeek,
            start: start.time,
            end: utcToLocal(row.endsAt, zone).time,
        },
        status: row.status,
        cancelReason: row.cancelReason,
        needsCompletion: row.needsCompletion,
        completedAt: row.completedAt,
        topic: row.topic,
    };
}

async function scheduleView(classSubjectId, zone) {
    const classSubject = await loadClassSubject(classSubjectId);
    const counts = await prisma.session.groupBy({
        by: ['status'],
        where: { classSubjectId },
        _count: { _all: true },
    });
    const count = (status) => counts.find((row) => row.status === status)?._count._all ?? 0;
    const waiting = await prisma.session.count({
        where: { classSubjectId, status: 'SCHEDULED', needsCompletion: true },
    });

    return {
        classSubject: {
            id: classSubject.id,
            class: classSubject.class.name,
            subject: classSubject.subject,
            semester: {
                id: classSubject.semester.id,
                ordinal: classSubject.semester.ordinal,
                academicYear: classSubject.semester.academicYear.label,
            },
        },
        timeZone: zone,
        // Always changeable (ticket 09): the first local date a change made now would
        // reach, so the frontend can say "berlaku mulai ...". Null with no zone yet.
        replansFrom: zone ? replansFrom(classSubject.semester, zone) : null,
        slots: classSubject.scheduleSlots.map(slotView),
        sessions: {
            scheduled: count('SCHEDULED'),
            cancelled: count('CANCELLED'),
            needsCompletion: waiting,
        },
    };
}

// ---------------------------------------------------------------------------
// Setting and reading
// ---------------------------------------------------------------------------

// The Principal or a Vice Principal sets a ClassSubject's weekly schedule, as often
// as needed (ticket 09). Before the Semester starts the whole Semester follows by
// number; after it, only what lies from tomorrow. A ClassSubject that has never had
// one, nor inherited Sessions, plans the whole Semester even after the start, and
// what lands before tomorrow waits for its teacher (owner, 2026-09-29).
async function setSchedule(auth, classSubjectId, { slots }) {
    await assertPrincipalOrVice(auth);

    const classSubject = await loadClassSubject(classSubjectId);
    if (classSubject.status !== 'ACTIVE' || classSubject.endedAt) {
        throw conflict('Only an active teaching assignment has a timetable');
    }
    if (classSubject.semester.status !== 'OPEN') {
        throw conflict(`Semester ${classSubject.semester.ordinal} is not open`);
    }
    if (classSubject.semester.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${classSubject.semester.academicYear.label} is closed`);
    }

    const zone = await zoneOf(auth.schoolId);
    if (!zone) throw conflict("Set the school's time zone (WIB, WITA or WIT) before its timetable");

    const wanted = slots.map((slot) => ({
        dayOfWeek: slot.dayOfWeek,
        startMinute: toMinute(slot.start),
        endMinute: toMinute(slot.end),
    }));
    await assertNoClash(classSubject, wanted);

    const now = new Date();
    const sessions = await prisma.session.count({ where: { classSubjectId } });
    const firstTime = classSubject.scheduleSlots.length === 0 && sessions === 0;
    const whole = firstTime || !hasStarted(classSubject.semester, zone, now);
    const target = targetOf(auth.schoolId, zone, classSubject, wanted);

    const planned = await prisma.$transaction(async (tx) => {
        await tx.classSubjectSchedule.updateMany({
            where: { classSubjectId, replacedAt: null },
            data: { replacedAt: now },
        });
        await tx.classSubjectSchedule.createMany({
            data: wanted.map((slot) => ({ classSubjectId, ...slot })),
        });
        return whole ? replanWhole(tx, target, now) : replanAhead(tx, target, now);
    });

    log.info(
        `Timetable set for ${classSubject.subject.code} in ${classSubject.class.name}: ` +
            `${wanted.length} slot(s), ${planned} session(s) planned ` +
            (whole ? 'for the whole semester' : `from ${tomorrowOf(zone, now)}`)
    );
    return scheduleView(classSubjectId, zone);
}

async function getSchedule(auth, classSubjectId) {
    await assertCanRead(auth, await loadClassSubject(classSubjectId));
    return scheduleView(classSubjectId, await zoneOf(auth.schoolId));
}

// A ClassSubject's Sessions in number order. A student's list also carries, on each
// Session, `content: { published, completed }` - their own count of its Content, so
// the frontend ticks its Session tabs without loading each Session's Content
// (teaching-and-learning 06 follow-up 2, owner 2026-10-06). Staff lists carry no
// such field, as their Content lists carry no progress. A student who left the Class
// gets the Sessions that began before they left, with their counts from then
// (teaching-and-learning 12).
async function listSessions(auth, classSubjectId, { status }) {
    const classSubject = await loadClassSubject(classSubjectId);
    const standing = await readerStandingOf(auth, classSubject);
    if (!standing) throw notFound('Class subject not found');

    // The student's placement there, for whose counts and up to when. Gone since the
    // check above: no longer a reader.
    const student = isStudentStanding(standing);
    const [placed] = student ? await placementsOf(auth.membershipId, classSubject.classId) : [];
    if (student && !placed) throw notFound('Class subject not found');

    const zone = await zoneOf(auth.schoolId);
    const rows = await prisma.session.findMany({
        where: {
            classSubjectId,
            ...(status ? { status } : {}),
            ...(placed?.leftAt ? { startsAt: { lt: placed.leftAt } } : {}),
        },
        orderBy: { number: 'asc' },
    });
    const views = rows.map((row) => sessionView(row, zone));
    if (!student) return views;

    const summary = await summaryBySessionOf(prisma, placed.studentProfileId, rows.map((row) => row.id));
    return views.map((view) => ({ ...view, content: summary.get(view.id) }));
}

// ---------------------------------------------------------------------------
// Calendars: a student's (/mine) and a teacher's (/teaching)
// ---------------------------------------------------------------------------

// The days a calendar asks for, in the school's zone: one date, a from-to range of
// up to six weeks (the schema's limit), or today.
function daysAsked(zone, { date, from, to }, now) {
    const today = zone ? utcToLocal(now, zone).date : null;
    return { first: from ?? date ?? today, last: to ?? date ?? today };
}

// A number cancelled because a plan stopped reaching it keeps a stale date
// (firstNumberFrom), so no calendar shows it. One cancelled for a holiday, as never
// held or as its subject stopped is shown, cancelled.
const SHOWN_ON_CALENDAR = { OR: [{ status: 'SCHEDULED' }, { cancelReason: { not: 'SCHEDULE_CHANGED' } }] };

// Which Class and subject a calendar's Session is. The Class by id and academic
// year as well as by name: two years may each have a 7A (2026-10-03).
const calendarFields = (classSubject) => ({
    classSubjectId: classSubject.id,
    classId: classSubject.classId,
    class: classSubject.class.name,
    academicYear: classSubject.class.academicYear.label,
    subject: classSubject.subject,
});

// When a Session's check-in opens: 30 minutes before its start (owner, 2026-10-08;
// at the start before that, teaching-and-learning 03). It closes at the Session's
// end, or at the teacher's confirmation if sooner. Attendance's checkIn enforces it,
// and a student's calendar shows it as canCheckIn - one rule for both. Being late
// still counts from the start.
const checkInOpeningOf = (session) => new Date(session.startsAt.getTime() - CHECK_IN_EARLY_MS);

// A student's Sessions over days of the school's calendar: one day, a range of up to
// six weeks for a calendar, or today (owner, 2026-10-02).
//
// - Whose: the Sessions of the Class the student was placed in AT THE TIME, read
//   from their placements. After a move from 7A to 7B, September shows 7A's with
//   its attendance, not 7B's they never sat in. A Session that overlaps two
//   placements on the day of a move is shown for both Classes, as check-in and the
//   roster each allow.
// - An ended ClassSubject's Sessions count too, since a Session between an ending
//   and a successor still takes check-ins (teaching-and-learning 03).
// - Cancelled numbers as SHOWN_ON_CALENDAR says. The holidays themselves are
//   GET /api/holidays, which every member reads.
// - Each carries the student's own attendance, and canCheckIn: whether a check-in
//   would be taken now, by the server's clock - the window
//   POST /api/attendance/sessions/:id/check-in enforces (checkInOpeningOf), current
//   Class included.
const ownAttendanceView = (row) => ({
    id: row.id,
    status: row.status,
    checkedInAt: row.checkedInAt,
    outsideSchool: row.outsideSchool,
    late: row.late,
});

async function listMine(auth, { date, from, to }) {
    // School is above tenancy, so this reads without a scope.
    const school = await prisma.school.findUnique({
        where: { id: auth.schoolId },
        select: { timeZone: true, latitude: true, longitude: true },
    });
    const zone = school?.timeZone ?? null;
    const now = new Date();
    const { first, last } = daysAsked(zone, { date, from, to }, now);

    const profile = await prisma.studentProfile.findFirst({
        where: { membershipId: auth.membershipId, endedAt: null },
        select: {
            id: true,
            classMemberships: {
                select: { classId: true, startedAt: true, endedAt: true, class: { select: { id: true, name: true } } },
            },
        },
    });
    const placements = profile?.classMemberships ?? [];
    const current = placements.find((placement) => placement.endedAt === null) ?? null;
    const empty = { from: first, to: last, timeZone: zone, class: current?.class ?? null, sessions: [] };
    // With no time zone there is no timetable, so no Session either.
    if (!profile || !zone) return empty;

    const rangeStart = midnightOf(first, zone);
    const rangeEnd = midnightOf(nextDay(last), zone);
    const inRange = placements.filter(
        (placement) => placement.startedAt < rangeEnd && (placement.endedAt === null || placement.endedAt > rangeStart)
    );
    if (inRange.length === 0) return empty;

    const rows = await prisma.session.findMany({
        where: {
            startsAt: { gte: rangeStart, lt: rangeEnd },
            AND: [
                {
                    OR: inRange.map((placement) => ({
                        classSubject: { classId: placement.classId, status: 'ACTIVE' },
                        endsAt: { gt: placement.startedAt },
                        ...(placement.endedAt ? { startsAt: { lt: placement.endedAt } } : {}),
                    })),
                },
                SHOWN_ON_CALENDAR,
            ],
        },
        include: { classSubject: { select: sessionClassSubjectSelect } },
        orderBy: { startsAt: 'asc' },
    });
    const own = await prisma.attendance.findMany({
        where: { studentProfileId: profile.id, sessionId: { in: rows.map((row) => row.id) } },
        select: { id: true, sessionId: true, status: true, checkedInAt: true, outsideSchool: true, late: true },
    });
    const ownBySession = new Map(own.map((row) => [row.sessionId, row]));

    const hasPoint = school.latitude !== null && school.longitude !== null;
    const canCheckIn = (row, attendance) =>
        hasPoint &&
        !attendance &&
        row.classSubject.classId === current?.classId &&
        row.status === 'SCHEDULED' &&
        row.completedAt === null &&
        now >= checkInOpeningOf(row) &&
        now < row.endsAt;

    return {
        ...empty,
        sessions: rows.map((row) => {
            const found = ownBySession.get(row.id);
            const attendance = found ? ownAttendanceView(found) : null;
            return {
                ...sessionView(row, zone),
                ...calendarFields(row.classSubject),
                attendance,
                canCheckIn: canCheckIn(row, attendance),
            };
        }),
    };
}

// A teacher's Sessions over the same days a student's calendar takes (2026-10-03):
// the ones they answer for - their live ClassSubjects', and what an ended one left
// in a slot they now teach (answeringTeacherOf, as attendance and content decide).
// A teacher whose assignment ended no longer sees its Sessions; the successor does.
// confirmed: its attendance is confirmed (POST /api/attendance/sessions/:id/confirm).
async function listTeaching(auth, { date, from, to }) {
    const zone = await zoneOf(auth.schoolId);
    const { first, last } = daysAsked(zone, { date, from, to }, new Date());
    const empty = { from: first, to: last, timeZone: zone, sessions: [] };
    // With no time zone there is no timetable, so no Session either.
    if (!zone) return empty;

    const slots = await prisma.classSubject.findMany({
        where: { teacherMembershipId: auth.membershipId, status: 'ACTIVE', endedAt: null },
        select: { classId: true, subjectId: true, semesterId: true },
    });
    if (slots.length === 0) return empty;

    const rows = await prisma.session.findMany({
        where: {
            startsAt: { gte: midnightOf(first, zone), lt: midnightOf(nextDay(last), zone) },
            classSubject: { status: 'ACTIVE', OR: slots },
            ...SHOWN_ON_CALENDAR,
        },
        include: { classSubject: { select: sessionClassSubjectSelect } },
        orderBy: { startsAt: 'asc' },
    });

    // Who answers each, worked out once per ClassSubject.
    const answerer = new Map();
    for (const { classSubject } of rows) {
        if (!answerer.has(classSubject.id)) {
            answerer.set(classSubject.id, await answeringTeacherOf(classSubject));
        }
    }

    return {
        ...empty,
        sessions: rows
            .filter((row) => answerer.get(row.classSubject.id) === auth.membershipId)
            .map((row) => ({
                ...sessionView(row, zone),
                ...calendarFields(row.classSubject),
                confirmed: row.completedAt !== null,
            })),
    };
}

// ---------------------------------------------------------------------------
// Sessions that need completion (ticket 09)
// ---------------------------------------------------------------------------

// The to-do list: Sessions created already past that still wait for their
// teacher's answer. A teacher sees the ones they answer for: their own, and those
// left on an ended ClassSubject in a slot they now teach (the successor answers,
// teaching-and-learning 03). The Principal and Vice Principals see the school's,
// including those waiting for a successor who is not there yet (answeredBy null).
// Nothing is emailed - the mailer stays verification and reset only.
async function listNeedingCompletion(auth) {
    const leader = await isPrincipalOrVice(auth.membershipId);

    let slots = null;
    if (!leader) {
        slots = await prisma.classSubject.findMany({
            where: { teacherMembershipId: auth.membershipId, status: 'ACTIVE', endedAt: null },
            select: { classId: true, subjectId: true, semesterId: true },
        });
        if (slots.length === 0) return [];
    }

    const rows = await prisma.session.findMany({
        where: {
            status: 'SCHEDULED',
            needsCompletion: true,
            classSubject: { status: 'ACTIVE', ...(slots ? { OR: slots } : {}) },
        },
        orderBy: [{ startsAt: 'asc' }, { number: 'asc' }],
        include: {
            classSubject: {
                select: {
                    id: true,
                    status: true,
                    endedAt: true,
                    classId: true,
                    subjectId: true,
                    semesterId: true,
                    teacherMembershipId: true,
                    class: { select: { name: true } },
                    subject: { select: { code: true, name: true } },
                    semester: {
                        select: { id: true, ordinal: true, academicYear: { select: { label: true } } },
                    },
                    teacher: { select: { id: true, user: { select: { fullName: true } } } },
                },
            },
        },
    });

    // Who answers each, worked out once per ClassSubject.
    const answerer = new Map();
    for (const { classSubject } of rows) {
        if (!answerer.has(classSubject.id)) {
            answerer.set(classSubject.id, await answeringTeacherOf(classSubject));
        }
    }
    const people = await prisma.schoolMembership.findMany({
        where: { id: { in: [...new Set([...answerer.values()].filter(Boolean))] } },
        select: { id: true, user: { select: { fullName: true } } },
    });
    const nameOf = new Map(people.map((person) => [person.id, person.user.fullName]));

    const zone = await zoneOf(auth.schoolId);
    return rows
        .filter((row) => leader || answerer.get(row.classSubject.id) === auth.membershipId)
        .map(({ classSubject, ...row }) => {
            const answeredBy = answerer.get(classSubject.id);
            return {
                ...sessionView(row, zone),
                classSubject: {
                    id: classSubject.id,
                    class: classSubject.class.name,
                    subject: classSubject.subject,
                    semester: {
                        id: classSubject.semester.id,
                        ordinal: classSubject.semester.ordinal,
                        academicYear: classSubject.semester.academicYear.label,
                    },
                    teacher: { membershipId: classSubject.teacher.id, fullName: classSubject.teacher.user.fullName },
                    ended: classSubject.endedAt !== null,
                },
                answeredBy: answeredBy ? { membershipId: answeredBy, fullName: nameOf.get(answeredBy) } : null,
            };
        });
}

// A Session waiting for completion, as its teacher answers for it. Whoever may not
// read it - another school included - gets 404; a reader who is not its teacher,
// 403. It must have begun: the answer is about a meeting, and there is no cancelling
// a single Session ahead of time (spec, 2026-09-27).
async function loadForAnswer(auth, sessionId, now) {
    const session = await prisma.session.findFirst({
        where: { id: sessionId },
        select: {
            id: true,
            number: true,
            status: true,
            startsAt: true,
            needsCompletion: true,
            classSubjectId: true,
        },
    });
    if (!session) throw notFound('Session not found');
    const classSubject = await loadClassSubject(session.classSubjectId);
    await assertCanRead(auth, classSubject);

    if ((await answeringTeacherOf(classSubject)) !== auth.membershipId) {
        throw forbidden('Only the teacher of this class subject answers for its Sessions');
    }
    if (session.status !== 'SCHEDULED' || !session.needsCompletion) {
        throw conflict(`Pertemuan ke-${session.number} is not waiting for completion`);
    }
    if (session.startsAt > now) throw conflict(`Pertemuan ke-${session.number} has not begun yet`);
    return { session, classSubject };
}

// "It never happened" - the subject had not started yet, say. CANCELLED as
// NOT_HELD; its number stays, and the next real meeting keeps its own.
async function markNotHeld(auth, sessionId) {
    const now = new Date();
    const { session, classSubject } = await loadForAnswer(auth, sessionId, now);
    const claimed = await prisma.session.updateMany({
        where: { id: session.id, status: 'SCHEDULED', needsCompletion: true },
        data: {
            status: 'CANCELLED',
            cancelReason: 'NOT_HELD',
            cancelledAt: now,
            needsCompletion: false,
        },
    });
    if (claimed.count === 0) throw conflict(`Pertemuan ke-${session.number} was answered already`);

    log.info(`${describeSession({ ...session, classSubject })} marked not held`);
    return sessionOf(auth, session.id);
}

async function sessionOf(auth, sessionId) {
    const row = await prisma.session.findFirst({ where: { id: sessionId } });
    return sessionView(row, await zoneOf(auth.schoolId));
}

// ---------------------------------------------------------------------------
// Hooks other modules call
// ---------------------------------------------------------------------------

// A ClassSubject just became ACTIVE (approved, overridden, or self-assigned by a
// homeroom teacher). If its slot's previous ClassSubject ended in this Semester -
// its teacher left - the new one inherits that schedule and every Session still
// ahead. Past Sessions stay with the one that taught them. Runs inside the
// caller's transaction and school scope.
async function inheritSchedule(tx, { id, classId, subjectId, semesterId }, now = new Date()) {
    const predecessor = await tx.classSubject.findFirst({
        where: {
            classId,
            subjectId,
            semesterId,
            id: { not: id },
            status: 'ACTIVE',
            endedAt: { not: null },
        },
        orderBy: { endedAt: 'desc' },
        select: {
            id: true,
            scheduleSlots: {
                where: { replacedAt: null },
                select: { dayOfWeek: true, startMinute: true, endMinute: true },
            },
        },
    });
    if (!predecessor || predecessor.scheduleSlots.length === 0) return false;

    await tx.classSubjectSchedule.createMany({
        data: predecessor.scheduleSlots.map((slot) => ({ classSubjectId: id, ...slot })),
    });
    await tx.session.updateMany({
        where: { classSubjectId: predecessor.id, startsAt: { gt: now } },
        data: { classSubjectId: id },
    });
    return true;
}

// A ClassSubject was just ended and the subject stops in its Class (ticket 10,
// owner 2026-09-29). Every Session still ahead is CANCELLED, and the timetable is
// stamped replaced, so nothing is left for a successor to inherit: a later
// teacher in the slot starts with a timetable of their own. Past Sessions and one
// already under way stay as they are. Runs inside the caller's transaction.
async function stopSessionsAhead(tx, classSubjectId, now = new Date()) {
    await tx.classSubjectSchedule.updateMany({
        where: { classSubjectId, replacedAt: null },
        data: { replacedAt: now },
    });
    const cancelled = await tx.session.updateMany({
        where: { classSubjectId, status: 'SCHEDULED', startsAt: { gt: now } },
        data: {
            status: 'CANCELLED',
            cancelReason: 'ASSIGNMENT_ENDED',
            cancelledAt: now,
            needsCompletion: false,
        },
    });
    return cancelled.count;
}

// The holiday calendar changed on these days (ticket 08), at these schools - or,
// for a national holiday, at every school. Before a Semester starts its Sessions
// are planned again, as if the calendar had always been so (owner, 2026-09-28).
// After it starts:
// - a day that now counts as a holiday cancels the Sessions still ahead on it, and
//   no other number changes (ticket 08);
// - a day from tomorrow on that stopped being one, and has a slot but no Session,
//   re-plans from tomorrow, so it is taught again (owner, 2026-09-29). A cancelled
//   number gets its date back empty: its Content already moved on. Past days and
//   today are never touched.
// A change only ever goes one way - days added, or days taken back - so the two
// never meet in one call.
async function onCalendarChanged(schoolIds, days) {
    if (days.length === 0) return;
    const schools = await prisma.school.findMany({
        where: {
            timeZone: { not: null },
            deactivatedAt: null,
            ...(schoolIds ? { id: { in: schoolIds } } : {}),
        },
        select: { id: true, name: true, timeZone: true },
    });

    for (const school of schools) {
        await runInSchool(school.id, school.name, () => resyncSchool(school, days));
    }
}

async function resyncSchool(school, days) {
    const sorted = [...new Set(days)].sort();
    const [firstDay, lastDay] = [sorted[0], sorted[sorted.length - 1]];
    const now = new Date();

    const affected = await prisma.classSubject.findMany({
        where: {
            ...plannedHere(now),
            semester: { startDate: { lte: toDate(lastDay) }, endDate: { gte: toDate(firstDay) } },
        },
        select: classSubjectSelect,
    });
    if (affected.length === 0) return;

    const holidays = await holidayDatesBetween(school.id, firstDay, lastDay);
    const nowHolidays = new Set(sorted.filter((day) => holidays.has(day)));
    const freed = sorted.filter((day) => !holidays.has(day) && day >= tomorrowOf(school.timeZone, now));

    for (const classSubject of affected) {
        const target = targetOf(school.id, school.timeZone, classSubject);
        if (!hasStarted(classSubject.semester, school.timeZone, now)) {
            await prisma.$transaction((tx) => replanWhole(tx, target, now));
            continue;
        }
        if (freed.length > 0 && (await lacksSessionOn(classSubject, freed, school.timeZone))) {
            await prisma.$transaction((tx) => replanAhead(tx, target, now));
            continue;
        }
        if (nowHolidays.size === 0) continue;

        const ahead = await prisma.session.findMany({
            where: {
                classSubjectId: classSubject.id,
                status: 'SCHEDULED',
                startsAt: { gt: now },
            },
            select: { id: true, startsAt: true },
        });
        const cancel = ahead.filter((row) => nowHolidays.has(utcToLocal(row.startsAt, school.timeZone).date));
        if (cancel.length > 0) {
            // Their Content moves on in the same step (teaching-and-learning 04).
            await prisma.$transaction(async (tx) => {
                await tx.session.updateMany({
                    where: { id: { in: cancel.map((row) => row.id) } },
                    data: {
                        status: 'CANCELLED',
                        cancelReason: 'HOLIDAY',
                        cancelledAt: now,
                        needsCompletion: false,
                    },
                });
                await moveContentOffHoliday(tx, classSubject.id, cancel);
            });
        }
    }
    log.info(`Sessions re-synced at ${school.name} for ${sorted.length} changed day(s)`);
}

// Whether a day that stopped being a holiday was one that kept this ClassSubject's
// Sessions away: inside its Semester, on a weekday its timetable teaches, and with
// no SCHEDULED Session. A day that was never off here - joint leave this school does
// not observe, say - has its Sessions, and re-plans nothing.
async function lacksSessionOn(classSubject, days, zone) {
    const { semester, scheduleSlots } = classSubject;
    const taught = days.filter(
        (day) =>
            day >= toDay(semester.startDate) &&
            day <= toDay(semester.endDate) &&
            scheduleSlots.some((slot) => slot.dayOfWeek === isoDayOf(day))
    );
    if (taught.length === 0) return false;

    const rows = await prisma.session.findMany({
        where: {
            classSubjectId: classSubject.id,
            status: 'SCHEDULED',
            startsAt: {
                gte: midnightOf(taught[0], zone),
                lt: midnightOf(nextDay(taught[taught.length - 1]), zone),
            },
        },
        select: { startsAt: true },
    });
    const held = new Set(rows.map((row) => utcToLocal(row.startsAt, zone).date));
    return taught.some((day) => !held.has(day));
}

// A Semester's dates stay changeable after its start (ticket 09, owner 2026-09-28),
// within two limits once it has Sessions. Its start date moves only while no
// meeting in it has happened - a Session whose attendance was confirmed, or one a
// student checked in to (ticket 03). Its end date never moves to before
// today. A start moved to a day already past is allowed: it is a correction, and
// the Sessions it makes in the past wait for their teacher. Called by academics
// before it updates the dates.
async function assertSemesterDatesMayChange(schoolId, semester, { startDate, endDate }) {
    const sessions = await prisma.session.count({ where: { classSubject: { semesterId: semester.id } } });
    if (sessions === 0) return;

    if (startDate.getTime() !== semester.startDate.getTime()) {
        // A meeting happened: its attendance was confirmed, or a student checked in
        // to it (teaching-and-learning 03 closes the lock ticket 09 left open).
        const confirmed = await prisma.session.count({
            where: { classSubject: { semesterId: semester.id }, completedAt: { not: null } },
        });
        const checkedIn = await prisma.attendance.count({
            where: { checkedInAt: { not: null }, session: { classSubject: { semesterId: semester.id } } },
        });
        if (confirmed + checkedIn > 0) {
            throw conflict('A meeting in this Semester has already happened, so its start date is fixed');
        }
    }

    const zone = await zoneOf(schoolId);
    const endMoves = endDate.getTime() !== semester.endDate.getTime();
    if (zone && endMoves && toDay(endDate) < utcToLocal(new Date(), zone).date) {
        throw conflict('The Semester cannot end before today');
    }
}

// After a Semester's dates changed, every timetable in it follows: the whole
// Semester when it has not started yet or its start date moved, and only what lies
// from tomorrow when just its end moved after the start - extended, new numbers
// continue; shortened, the ones past the new end are CANCELLED.
async function regenerateSemester(schoolId, semesterId, { startMoved }) {
    const zone = await zoneOf(schoolId);
    if (!zone) return;
    const now = new Date();
    const scheduled = await prisma.classSubject.findMany({
        where: { semesterId, ...plannedHere(now) },
        select: classSubjectSelect,
    });

    for (const classSubject of scheduled) {
        const target = targetOf(schoolId, zone, classSubject);
        const whole = startMoved || !hasStarted(classSubject.semester, zone, now);
        await prisma.$transaction((tx) =>
            whole ? replanWhole(tx, target, now) : replanAhead(tx, target, now)
        );
    }
}

// The school's time zone changed (ticket 09, owner 2026-09-28). Every Session from
// tomorrow on - the old zone's tomorrow - keeps its wall-clock time and takes the
// new zone's instant: 07:30 stays 07:30. Past Sessions and today's stay as they
// were; moved two hours, one later today could slip into the past before its
// check-in ever opened. Numbers and local dates do not change, so the holidays still
// fall where they did. Every Session counts, a leaver's still waiting for its
// successor too. Runs inside the caller's transaction.
//
// One raw UPDATE, the only raw query in src/ (owner, 2026-09-29). Through Prisma it
// took 11.6 s for a 24-class school and 25 s for 48 - a write per distinct instant,
// every row read first - against 1.2 s for this on the same 38,000 rows. A raw query
// bypasses the tenant extension in prisma.js, so the school is named here by hand:
// never drop "schoolId" from the WHERE. "updatedAt" too, which Prisma would set.
async function onTimeZoneChanged(tx, schoolId, fromZone, toZone, now = new Date()) {
    const keepBefore = midnightOf(tomorrowOf(fromZone, now), fromZone);
    // Whole hours: each zone is a fixed offset (src/shared/timeZone.js), so any date gives it.
    const hours = (midnightOf('2000-01-01', toZone) - midnightOf('2000-01-01', fromZone)) / (60 * 60 * 1000);
    return tx.$executeRaw`
        UPDATE "Session"
        SET "startsAt" = "startsAt" + make_interval(hours => ${hours}::int),
            "endsAt" = "endsAt" + make_interval(hours => ${hours}::int),
            "updatedAt" = ${now}
        WHERE "schoolId" = ${schoolId} AND "startsAt" >= ${keepBefore}
    `;
}

export {
    setSchedule,
    getSchedule,
    listSessions,
    listMine,
    listTeaching,
    listNeedingCompletion,
    markNotHeld,
    answeringTeacherOf,
    staffStandingOf,
    readerStandingOf,
    isStudentStanding,
    todayOf,
    semesterSpan,
    sessionSelect,
    loadSession,
    describeSession,
    checkInOpeningOf,
    inheritSchedule,
    stopSessionsAhead,
    onCalendarChanged,
    assertSemesterDatesMayChange,
    regenerateSemester,
    onTimeZoneChanged,
};
