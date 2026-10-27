import { prisma } from '../../shared/prisma.js';
import { runInSchool } from '../../shared/tenantContext.js';
import { utcToLocal } from '../../shared/timeZone.js';
import { createLogger } from '../../lib/helpers.js';
import { currentTermOf } from '../academics/academics.term.js';
import { toDay } from '../holidays/holidays.calendar.js';
import { progressOf } from '../tracking/tracking.service.js';
import { SLOTS_AT_ONCE, mapAtMost, orderedSlotsOf } from '../grading/grading.finalising.js';
import { placedNowIn } from '../grading/grading.texts.js';
import { slotSelect } from './dashboard.service.js';
import { thresholdsOf } from './dashboard.settings.js';
import {
    absencesOf,
    absentDaysOf,
    activeSinceOf,
    classSignalsOf,
    signalWindowsOf,
    slotFactsOf,
    studentsNeedingSupportOf,
} from './dashboard.signals.js';

const log = createLogger('Dashboard');

// The nightly rollup (dashboard ticket 05, the spec's D5 and D6): each School's numbers,
// counted once a night and kept a row per day, per slot, per Class and per School, so the
// Principal's aggregate (ticket 06) and the Governing Body's rows (ticket 07) read stored
// counts instead of every slot live (12-26 s for a School of 450 slots, by the machine, of
// which the write is about 0.6 s; probes/05-rollup-measure.mjs). This file is the only writer
// of the three tables.
//
// Owner's decisions (2026-10-26, the spec; 2026-10-27, the plan, through the picker):
// - An hourly timer in the process, no new dependency. Each School whose local time is past
//   01:00 and that has no row for its local today is rolled up, so a School missed while
//   the server slept is caught up at the next run. A missed night is not filled in later:
//   what was then cannot be read now.
// - Started only once server.js listens, never by importing the app.
// - Three tables (the proposal). A slot row is keyed by the slot, so a replaced teacher
//   does not break the 7-day change. Each counts, never a percentage.
// - The slot row's Students with a signal are the teacher's rule (studentsNeedingSupportOf,
//   ticket 02); the Class row's are the Homeroom Teacher's (classSignalsOf, ticket 03), so
//   each list equals the view of the one who answers for it.
// - The Class row's Students placed, below the KKTP somewhere and with a signal are counted
//   once each; the School row sums its Class rows, a Student being placed in one Class.
// - Daily rows are kept a year, then pruned, but for each Semester's last day, which the
//   Principal reads for a CLOSED Semester (owner's pick, against keeping everything): the
//   owner's yes to this one automatic delete, of the rollup's own rows.
// - Only the current Semester (currentTermOf), once begun and while not CLOSED. A
//   deactivated School is skipped, its last rows kept. A School with no time zone has no
//   Sessions and is rolled up by WIB.
// - LearningEvent is never read (handoff #24). Reading attempts closes one past its
//   deadline (assessment ticket 03), at night too.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The local hour from which a School is due.
const ROLLUP_HOUR = 1;

// A School with no time zone is rolled up by WIB (the spec's defaults).
const FALLBACK_ZONE = 'WIB';

// How long a day's rows are kept, but for a Semester's last (owner, 2026-10-27).
const KEEP_DAYS = 365;

// What rollupSchool did, for the timer's log line and the probe.
const ROLLED_UP = 'ROLLED_UP';
const NOT_DUE = 'NOT_DUE';
const DONE_ALREADY = 'DONE_ALREADY';
const NO_SEMESTER = 'NO_SEMESTER';

// The counts a slot row's Class sums, and a Class row's School.
const SUMMED = [
    'attendancePresent',
    'attendanceCounted',
    'contentCompleted',
    'contentPossible',
    'gradeSum',
    'gradeCount',
];
const COUNTED = ['studentsPlacedNow', 'belowKktp', 'withSignal'];

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

const sumOf = (rows, keys) =>
    Object.fromEntries(keys.map((key) => [key, rows.reduce((sum, row) => sum + row[key], 0)]));

// The School's local date and hour at a moment.
function localMomentOf(school, now) {
    const { date, time } = utcToLocal(now, school.timeZone ?? FALLBACK_ZONE);
    return { date, hour: Number(time.slice(0, 2)) };
}

// One slot over the Students placed in its Class now: its row's numbers, its Students
// below the KKTP, and what the Class's signals are read from (classSignalsOf).
async function slotOf(context, slot, placement) {
    const { system, thresholds, windows } = context;
    const { placed, names, activeSince } = placement;
    const [progress, slotFacts, absentOf] = await Promise.all([
        progressOf(slot, placed),
        slotFactsOf(system, slot, windows),
        absencesOf(slot, placed, windows),
    ]);
    const facts = { ...slotFacts, absentOf, activeSince };
    const { book } = facts;

    let attendancePresent = 0;
    let attendanceCounted = 0;
    let contentCompleted = 0;
    for (const student of progress.students.values()) {
        attendancePresent += student.attendance.present;
        attendanceCounted += student.attendance.counted;
        contentCompleted += student.contents.completed;
    }
    // A grade where the slot reports the Student, as the views show it.
    const grades = placed
        .filter((studentProfileId) => book.reporting.isReportedHere(studentProfileId))
        .map((studentProfileId) => [studentProfileId, book.gradeOf(studentProfileId).finalGrade?.value ?? null])
        .filter(([, grade]) => grade !== null);
    const below = grades
        .filter(([, grade]) => grade < book.settings.kktp.value)
        .map(([studentProfileId]) => studentProfileId);
    const flagged = studentsNeedingSupportOf({
        roster: { nameOf: names },
        placed,
        progress,
        facts,
        thresholds,
        windows,
    });

    return {
        entry: { slot, progress, facts },
        below,
        row: {
            classId: slot.classId,
            subjectId: slot.subjectId,
            studentsPlacedNow: placed.length,
            attendancePresent,
            attendanceCounted,
            contentCompleted,
            contentPossible: progress.contents.length * placed.length,
            gradeSum: grades.reduce((sum, [, grade]) => sum + grade, 0),
            gradeCount: grades.length,
            belowKktp: below.length,
            withSignal: flagged.length,
        },
    };
}

// One Class with its slots of the Semester: their rows, and its own, which counts each of
// its Students once.
async function classOf(context, classId, rows) {
    const { system, semester, thresholds, windows } = context;
    const names = await placedNowIn(classId);
    const placed = [...names.keys()];
    const [activeSince, absentDays] = await Promise.all([
        activeSinceOf(system, classId, semester, placed),
        absentDaysOf(semester.id, placed, windows),
    ]);
    const slots = await mapAtMost(orderedSlotsOf(rows), SLOTS_AT_ONCE, (slot) =>
        slotOf(context, slot, { placed, names, activeSince })
    );

    const entries = slots.map((slot) => slot.entry);
    const signalled = { slots: entries, absentDays, activeSince, thresholds, windows };
    const flagged = placed.filter((studentProfileId) => classSignalsOf(studentProfileId, signalled).length > 0);
    const slotRows = slots.map((slot) => slot.row);
    return {
        slotRows,
        row: {
            classId,
            studentsPlacedNow: placed.length,
            ...sumOf(slotRows, SUMMED),
            belowKktp: new Set(slots.flatMap((slot) => slot.below)).size,
            withSignal: flagged.length,
        },
    };
}

// The Semester to roll up: the current one, begun by the School's today and not CLOSED.
async function semesterToRollOf(school, date, now) {
    const { semester } = await currentTermOf(school.id, now);
    if (!semester || toDay(semester.startDate) > date) return null;
    const { status } = await prisma.semester.findFirst({ where: { id: semester.id }, select: { status: true } });
    return status === 'CLOSED' ? null : semester;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// The School's daily rows older than a year, but for each Semester's last day, in the
// rollup's transaction. A School's three tables share their days, so the School rows say
// which day is a Semester's last.
async function pruneOldRows(tx, localDate) {
    const before = new Date(localDate.getTime() - KEEP_DAYS * DAY_MS);
    const lastDays = await tx.schoolDailyRollup.groupBy({ by: ['semesterId'], _max: { localDate: true } });
    const where = {
        localDate: { lt: before },
        NOT: lastDays.map((row) => ({ semesterId: row.semesterId, localDate: row._max.localDate })),
    };
    const pruned = await Promise.all([
        tx.slotDailyRollup.deleteMany({ where }),
        tx.classDailyRollup.deleteMany({ where }),
        tx.schoolDailyRollup.deleteMany({ where }),
    ]);
    return pruned.reduce((sum, result) => sum + result.count, 0);
}

// One School's rollup at a moment, in its own scope: nothing before its local 01:00, once
// a local day, and only for a Semester to roll up. All its rows are written in one
// transaction, the School's first as the claim: a second process at the same moment loses
// on its unique key and is told the day is done. The probe calls it with a fixed moment.
async function rollupSchool(school, now = new Date()) {
    return runInSchool(school.id, school.name, async () => {
        const { date, hour } = localMomentOf(school, now);
        if (hour < ROLLUP_HOUR) return NOT_DUE;
        const localDate = new Date(date);
        const isDone = async () => (await prisma.schoolDailyRollup.count({ where: { localDate } })) > 0;
        if (await isDone()) return DONE_ALREADY;
        const semester = await semesterToRollOf(school, date, now);
        if (!semester) return NO_SEMESTER;

        const started = Date.now();
        const [thresholds, rows] = await Promise.all([
            thresholdsOf(),
            prisma.classSubject.findMany({
                where: { semesterId: semester.id, status: 'ACTIVE' },
                select: { ...slotSelect, endedAt: true },
            }),
        ]);
        const windows = await signalWindowsOf(school.id, thresholds, now);
        const context = { system: { schoolId: school.id }, semester, thresholds, windows };
        const byClass = new Map();
        for (const row of rows) {
            if (!byClass.has(row.classId)) byClass.set(row.classId, []);
            byClass.get(row.classId).push(row);
        }
        const classes = [];
        for (const [classId, ofClass] of byClass) classes.push(await classOf(context, classId, ofClass));

        const day = { semesterId: semester.id, localDate, takenAt: now };
        const classRows = classes.map((klass) => klass.row);
        const slotRows = classes.flatMap((klass) => klass.slotRows);
        const writing = Date.now();
        let pruned;
        try {
            pruned = await prisma.$transaction(async (tx) => {
                await tx.schoolDailyRollup.create({
                    data: { ...day, ...sumOf(classRows, [...SUMMED, ...COUNTED]) },
                });
                await tx.classDailyRollup.createMany({ data: classRows.map((row) => ({ ...day, ...row })) });
                await tx.slotDailyRollup.createMany({ data: slotRows.map((row) => ({ ...day, ...row })) });
                return pruneOldRows(tx, localDate);
            });
        } catch (error) {
            if (error?.code === 'P2002' && (await isDone())) return DONE_ALREADY;
            throw error;
        }
        log.info(
            `Rolled up ${date}: ${slotRows.length} slots, ${classRows.length} Classes in ` +
                `${Date.now() - started} ms, ${Date.now() - writing} of them writing; ${pruned} old rows pruned`
        );
        return ROLLED_UP;
    });
}

// Every School not deactivated, one at a time, each at its own moment unless the probe
// fixes one. A School failing is logged and the others go on.
async function rollupSchools(now) {
    const schools = await prisma.school.findMany({
        where: { deactivatedAt: null },
        select: { id: true, name: true, timeZone: true },
        orderBy: { createdAt: 'asc' },
    });
    const outcome = { rolledUp: [], failed: [] };
    for (const school of schools) {
        try {
            if ((await rollupSchool(school, now ?? new Date())) === ROLLED_UP) outcome.rolledUp.push(school.id);
        } catch (error) {
            outcome.failed.push(school.id);
            log.error(`Rollup failed at ${school.name} (${school.id}):`, error);
        }
    }
    if (outcome.rolledUp.length + outcome.failed.length > 0) {
        log.info(`Rollup: ${outcome.rolledUp.length} Schools rolled up, ${outcome.failed.length} failed`);
    }
    return outcome;
}

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

let running = false;

// One hourly run, skipped while the last is still going.
async function runOnce() {
    if (running) {
        log.warn('Rollup: the last run is still going; this hour is skipped');
        return;
    }
    running = true;
    try {
        await rollupSchools();
    } catch (error) {
        log.error('Rollup run failed:', error);
    } finally {
        running = false;
    }
}

// Called by server.js once it listens, never on import, so a probe importing the app
// starts no timer: one run now, to catch up, then one every hour.
function startRollupTimer() {
    log.info('Rollup timer started: every hour, each School once its local time is past 01:00');
    void runOnce();
    return setInterval(() => void runOnce(), HOUR_MS);
}

export { rollupSchool, rollupSchools, startRollupTimer, ROLLED_UP, NOT_DUE, DONE_ALREADY, NO_SEMESTER };
