import { prisma } from '../../shared/prisma.js';
import { todayOf, localDaysSpan, semesterSpan } from '../sessions/sessions.service.js';
import { CONFIRMED_SESSION } from '../attendance/attendance.service.js';
import { slotSessionWhere } from '../tracking/tracking.service.js';
import { byName } from '../assessment/assessment.marking.js';
import { gradeBookOf } from '../grading/grading.grades.js';

// The Support Signals of one slot (dashboard ticket 02, the spec's D2): which of its
// Students placed now may need help, and the evidence, each against the School's threshold
// (dashboard.settings.js). Read from Attendance, Content Progress, the check-ins and the
// grade book; never LearningEvent (handoff #24).
//
// Owner's decisions (2026-10-26, the spec; 2026-10-27, the plan, through the picker):
// - FREQUENT_ABSENCE: ABSENT at the slot's confirmed Sessions of the last N local days,
//   today included. SICK, EXCUSED and an unconfirmed Session do not count.
// - CONTENT_BEHIND: completed under the percentage of the slot's published Content, once
//   enough is published. Compared exactly, not on a rounded percentage.
// - NOT_SUBMITTING: the grade book's "did not submit", graded Assessments only, so never
//   a LATIHAN.
// - BELOW_KKTP: the grade book's final grade under the slot's KKTP, once it has one - a
//   "did not submit" 0 included - compared rounded, as the Report Card prints it.
// - INACTIVE: no activity in the slot - Content (lastActivityAt) or a check-in - for the
//   last N local days, while a Session of the slot that was not cancelled started in
//   them, confirmed or not: a holiday or an Exam Week cancels its Sessions and raises
//   nothing. Only for a Student placed in the Class, with the Semester begun, for the
//   whole window: one placed three days ago is not flagged.
// - Only the Students placed now are flagged: a support list is for those still there.

const DAY_MS = 24 * 60 * 60 * 1000;

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

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// What a slot's signals are raised from, beside progressOf's rows, which its caller
// reads: the grade book, each Student's absences in the window, whether a Session was
// held in the inactive window, and since when each Student could have been active here.
// Null when nobody is placed in the Class now.
async function signalFactsOf(auth, slot, placed, windows) {
    if (placed.length === 0) return null;

    const sessionWhere = slotSessionWhere(slot);
    const [book, absences, held, placements, span] = await Promise.all([
        gradeBookOf(auth, slot, windows.now),
        prisma.attendance.groupBy({
            by: ['studentProfileId'],
            where: {
                studentProfileId: { in: placed },
                status: 'ABSENT',
                session: {
                    ...sessionWhere,
                    ...CONFIRMED_SESSION,
                    startsAt: { gte: windows.absenceFrom, lt: windows.tomorrowStart },
                },
            },
            _count: { _all: true },
        }),
        prisma.session.count({
            where: { ...sessionWhere, status: 'SCHEDULED', startsAt: { gte: windows.inactiveFrom, lte: windows.now } },
        }),
        // Their open placement in the Class, currentPlacement's row, read for all at once.
        prisma.classMembership.findMany({
            where: { classId: slot.classId, endedAt: null, studentProfileId: { in: placed } },
            select: { studentProfileId: true, startedAt: true },
        }),
        semesterSpan(auth.schoolId, slot.semester),
    ]);

    return {
        book,
        absentOf: new Map(absences.map((row) => [row.studentProfileId, row._count._all])),
        heldSessions: held,
        placedSinceOf: new Map(placements.map((row) => [row.studentProfileId, row.startedAt])),
        semesterStart: span.start,
    };
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

// One Student's signals in the slot, in a fixed order, each { type, value, threshold }.
function signalsOf(studentProfileId, { progress, facts, thresholds, windows }) {
    const signals = [];
    const raise = (type, value, threshold) => signals.push({ type, value, threshold });
    const { contents, lastActivityAt } = progress.students.get(studentProfileId);
    const { book } = facts;

    const absent = facts.absentOf.get(studentProfileId) ?? 0;
    if (absent >= thresholds.absenceCount) raise('FREQUENT_ABSENCE', absent, thresholds.absenceCount);

    const { published, completed } = contents;
    const behind = completed * 100 < thresholds.contentBehindPercent * published;
    if (published >= thresholds.contentBehindMinPublished && behind) {
        // Rounded down, so a Student flagged never reads as at the threshold.
        raise('CONTENT_BEHIND', Math.floor((completed * 100) / published), thresholds.contentBehindPercent);
    }

    if (book.reporting.isReportedHere(studentProfileId)) {
        const grade = book.gradeOf(studentProfileId);
        const kktp = book.settings.kktp.value;
        if (grade.didNotSubmit >= thresholds.notSubmittedCount) {
            raise('NOT_SUBMITTING', grade.didNotSubmit, thresholds.notSubmittedCount);
        }
        if (grade.finalGrade && grade.finalGrade.value < kktp) raise('BELOW_KKTP', grade.finalGrade.value, kktp);
    }

    const placedSince = facts.placedSinceOf.get(studentProfileId);
    const hereWholeWindow =
        placedSince && placedSince <= windows.inactiveFrom && facts.semesterStart <= windows.inactiveFrom;
    const idle = !lastActivityAt || lastActivityAt < windows.inactiveFrom;
    if (facts.heldSessions > 0 && hereWholeWindow && idle) {
        // Null for one never active in the slot.
        const days = lastActivityAt ? daysBefore(lastActivityAt, windows.todayStart) : null;
        raise('INACTIVE', days, thresholds.inactiveDays);
    }

    return signals;
}

// The slot's Students placed now who have a signal, by name.
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

export { signalWindowsOf, signalFactsOf, studentsNeedingSupportOf };
