import { prisma } from '../../shared/prisma.js';
import { todayOf, localDaysSpan, semesterSpan } from '../sessions/sessions.service.js';
import { CONFIRMED_SESSION } from '../attendance/attendance.service.js';
import { latest, slotSessionWhere } from '../tracking/tracking.service.js';
import { byName } from '../assessment/assessment.marking.js';
import { gradeBookOf } from '../grading/grading.grades.js';

// The Support Signals (dashboard ticket 02, the spec's D2): which Students placed now may need
// help, and the evidence, each against the School's threshold (dashboard.settings.js). Read
// from Attendance, Content Progress, the check-ins and the grade book; never LearningEvent
// (handoff #24). The teacher's view reads them per slot; the Homeroom Teacher's (ticket 03)
// across the Class's slots.
//
// Owner's decisions (2026-10-26, the spec; 2026-10-27, the plans of tickets 02 and 03,
// through the picker):
// - FREQUENT_ABSENCE: ABSENT at confirmed Sessions of the last N local days, today
//   included. SICK, EXCUSED and an unconfirmed Session do not count. The teacher's view
//   counts the slot's absences; the Homeroom Teacher's counts days with at least one,
//   whatever the Subject or the Class (ticket 03): a day absent in five Subjects is one. Both
//   count the current Semester's only (owner, 2026-10-27): early in Semester 2, the window
//   does not reach back into Semester 1.
// - CONTENT_BEHIND: completed under the percentage of the slot's published Content, once
//   enough is published. Compared exactly, not on a rounded percentage.
// - NOT_SUBMITTING: the grade book's "did not submit", graded Assessments only, so never
//   a LATIHAN.
// - BELOW_KKTP: the grade book's final grade under the slot's KKTP, once it has one - a
//   "did not submit" 0 included - compared rounded, as the Report Card prints it.
// - INACTIVE: no activity - Content (lastActivityAt) or a check-in - for the last N local
//   days, while a Session that was not cancelled started in them, confirmed or not: a
//   holiday or an Exam Week cancels its Sessions and raises nothing. Only for a Student
//   placed in the Class, with the Semester begun, for the whole window: one placed three
//   days ago is not flagged. Per slot in the teacher's view; across the Class's slots in
//   the Homeroom Teacher's, where activity in any Subject counts.
// - Only the Students placed now are flagged: a support list is for those still there.

const DAY_MS = 24 * 60 * 60 * 1000;

// The order a Student's signals are listed in, Subject by Subject within a type.
const TYPE_ORDER = ['FREQUENT_ABSENCE', 'CONTENT_BEHIND', 'NOT_SUBMITTING', 'BELOW_KKTP', 'INACTIVE'];

// ---------------------------------------------------------------------------
// The windows
// ---------------------------------------------------------------------------

// Where "the last N days" start, read once per request. The zones are fixed offsets
// (timeZone.js) and a School with none counts UTC days, so a local day is 24 hours and
// the N days ending today start N - 1 days before today's midnight.
async function signalWindowsOf(schoolId, thresholds, now) {
    const today = await todayOf(schoolId, now);
    const { start: todayStart, end: tomorrowStart } = await localDaysSpan(schoolId, today, today);
    const daysBack = (days) => new Date(todayStart.getTime() - (days - 1) * DAY_MS);
    return {
        now,
        todayStart,
        tomorrowStart,
        absenceFrom: daysBack(thresholds.absenceWindowDays),
        inactiveFrom: daysBack(thresholds.inactiveDays),
    };
}

// Whole local days from an instant to today: 1 for yesterday.
const daysBefore = (instant, todayStart) =>
    instant >= todayStart ? 0 : Math.ceil((todayStart.getTime() - instant.getTime()) / DAY_MS);

// The ABSENT that count: at a confirmed Session started in the absence window.
const absentInWindow = (windows) => ({
    status: 'ABSENT',
    session: { ...CONFIRMED_SESSION, startsAt: { gte: windows.absenceFrom, lt: windows.tomorrowStart } },
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// A slot's own facts, for either view: its grade book, and how many of its Sessions that
// were not cancelled started in the inactive window.
async function slotFactsOf(auth, slot, windows) {
    const [book, heldSessions] = await Promise.all([
        gradeBookOf(auth, slot, windows.now),
        prisma.session.count({
            where: {
                ...slotSessionWhere(slot),
                status: 'SCHEDULED',
                startsAt: { gte: windows.inactiveFrom, lte: windows.now },
            },
        }),
    ]);
    return { book, heldSessions };
}

// Each Student's ABSENT at the slot's Sessions in the window: the teacher's view.
async function absencesOf(slot, placed, windows) {
    const where = absentInWindow(windows);
    const rows = await prisma.attendance.groupBy({
        by: ['studentProfileId'],
        where: { ...where, studentProfileId: { in: placed }, session: { ...where.session, ...slotSessionWhere(slot) } },
        _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.studentProfileId, row._count._all]));
}

// Each Student's local days with an ABSENT in the window, at any Session of theirs in the
// Semester, the Class they sat in before a move included: the Homeroom Teacher's view
// (ticket 03, owner 2026-10-27). The window starts at a local midnight and a local day is
// 24 hours, so a Session's day is its offset from it.
async function absentDaysOf(semesterId, placed, windows) {
    const where = absentInWindow(windows);
    const rows = await prisma.attendance.findMany({
        where: {
            ...where,
            studentProfileId: { in: placed },
            session: { ...where.session, classSubject: { semesterId } },
        },
        select: { studentProfileId: true, session: { select: { startsAt: true } } },
    });
    const days = new Map(placed.map((studentProfileId) => [studentProfileId, new Set()]));
    for (const row of rows) {
        days.get(row.studentProfileId).add(Math.floor((row.session.startsAt - windows.absenceFrom) / DAY_MS));
    }
    return new Map([...days].map(([studentProfileId, found]) => [studentProfileId, found.size]));
}

// Since when each Student placed in the Class now could have been active in it: the later
// of their open placement (currentPlacement's row, read for all at once) and the
// Semester's start. One with no open placement there has no entry.
async function activeSinceOf(auth, classId, semester, placed) {
    const [placements, span] = await Promise.all([
        prisma.classMembership.findMany({
            where: { classId, endedAt: null, studentProfileId: { in: placed } },
            select: { studentProfileId: true, startedAt: true },
        }),
        semesterSpan(auth.schoolId, semester),
    ]);
    return new Map(
        placements.map((row) => [row.studentProfileId, row.startedAt > span.start ? row.startedAt : span.start])
    );
}

// What one slot's signals are raised from in the teacher's view, beside progressOf's rows,
// which its caller reads. Null when nobody is placed in the Class now.
async function signalFactsOf(auth, slot, placed, windows) {
    if (placed.length === 0) return null;
    const [facts, absentOf, activeSince] = await Promise.all([
        slotFactsOf(auth, slot, windows),
        absencesOf(slot, placed, windows),
        activeSinceOf(auth, slot.classId, slot.semester, placed),
    ]);
    return { ...facts, absentOf, activeSince };
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const signalOf = (type, value, threshold) => ({ type, value, threshold });

// Absences in a slot, or days with one across the Class, at the School's count.
const absenceSignalOf = (count, thresholds) =>
    count >= thresholds.absenceCount ? signalOf('FREQUENT_ABSENCE', count, thresholds.absenceCount) : null;

function contentSignalOf({ published, completed }, thresholds) {
    const behind = completed * 100 < thresholds.contentBehindPercent * published;
    if (published < thresholds.contentBehindMinPublished || !behind) return null;
    // Rounded down, so a Student flagged never reads as at the threshold.
    return signalOf('CONTENT_BEHIND', Math.floor((completed * 100) / published), thresholds.contentBehindPercent);
}

// NOT_SUBMITTING and BELOW_KKTP, where the slot reports the Student.
function gradeSignalsOf(book, studentProfileId, thresholds) {
    if (!book.reporting.isReportedHere(studentProfileId)) return [];
    const grade = book.gradeOf(studentProfileId);
    const kktp = book.settings.kktp.value;
    return [
        grade.didNotSubmit >= thresholds.notSubmittedCount
            ? signalOf('NOT_SUBMITTING', grade.didNotSubmit, thresholds.notSubmittedCount)
            : null,
        grade.finalGrade && grade.finalGrade.value < kktp ? signalOf('BELOW_KKTP', grade.finalGrade.value, kktp) : null,
    ];
}

// Idle through the whole window, here for all of it, while Sessions were held. The value
// is null for one never active.
function inactiveSignalOf({ lastActivityAt, activeSince, heldSessions }, thresholds, windows) {
    const hereWholeWindow = activeSince && activeSince <= windows.inactiveFrom;
    const idle = !lastActivityAt || lastActivityAt < windows.inactiveFrom;
    if (heldSessions === 0 || !hereWholeWindow || !idle) return null;
    const days = lastActivityAt ? daysBefore(lastActivityAt, windows.todayStart) : null;
    return signalOf('INACTIVE', days, thresholds.inactiveDays);
}

// One Student's signals in one slot, the teacher's view.
function signalsOf(studentProfileId, { progress, facts, thresholds, windows }) {
    const { contents, lastActivityAt } = progress.students.get(studentProfileId);
    const activity = {
        lastActivityAt,
        activeSince: facts.activeSince.get(studentProfileId),
        heldSessions: facts.heldSessions,
    };
    return [
        absenceSignalOf(facts.absentOf.get(studentProfileId) ?? 0, thresholds),
        contentSignalOf(contents, thresholds),
        ...gradeSignalsOf(facts.book, studentProfileId, thresholds),
        inactiveSignalOf(activity, thresholds, windows),
    ].filter(Boolean);
}

// The slot's Students placed now who have a signal, by name: the teacher's view.
function studentsNeedingSupportOf({ roster, placed, progress, facts, thresholds, windows }) {
    if (!facts) return [];
    return placed
        .map((studentProfileId) => ({
            studentProfileId,
            fullName: roster.nameOf.get(studentProfileId) ?? null,
            signals: signalsOf(studentProfileId, { progress, facts, thresholds, windows }),
        }))
        .filter((student) => student.signals.length > 0)
        .sort(byName);
}

// One Student's signals across the Class, the Homeroom Teacher's view (ticket 03): each
// slot's content and grade signals, naming its Subject, and the Class's own
// FREQUENT_ABSENCE (days) and INACTIVE (any Subject), naming none. By type, then in the
// slots' order.
function classSignalsOf(studentProfileId, { slots, absentDays, activeSince, thresholds, windows }) {
    const ofSlots = slots.flatMap(({ slot, progress, facts }) =>
        [
            contentSignalOf(progress.students.get(studentProfileId).contents, thresholds),
            ...gradeSignalsOf(facts.book, studentProfileId, thresholds),
        ]
            .filter(Boolean)
            .map((signal) => ({ ...signal, subject: slot.subject }))
    );
    const activity = {
        lastActivityAt: slots.reduce(
            (found, { progress }) => latest(found, progress.students.get(studentProfileId).lastActivityAt),
            null
        ),
        activeSince: activeSince.get(studentProfileId),
        heldSessions: slots.reduce((sum, { facts }) => sum + facts.heldSessions, 0),
    };
    const ofClass = [
        absenceSignalOf(absentDays.get(studentProfileId) ?? 0, thresholds),
        inactiveSignalOf(activity, thresholds, windows),
    ]
        .filter(Boolean)
        .map((signal) => ({ ...signal, subject: null }));
    return [...ofClass, ...ofSlots].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
}

export {
    signalWindowsOf,
    slotFactsOf,
    absentDaysOf,
    activeSinceOf,
    signalFactsOf,
    studentsNeedingSupportOf,
    classSignalsOf,
};
