import { prisma } from '../../shared/prisma.js';
import { isHomeroomOf, isPrincipalOrVice } from '../../shared/guards.js';
import { notFound } from '../../shared/errors.js';
import { currentTermOf } from '../academics/academics.term.js';
import { attendanceCounts } from '../attendance/attendance.service.js';
import { progressOf } from '../tracking/tracking.service.js';
import { byName } from '../assessment/assessment.marking.js';
import { SLOTS_AT_ONCE, mapAtMost, orderedSlotsOf } from '../grading/grading.finalising.js';
import { placedNowIn } from '../grading/grading.texts.js';
import { percentOf, semesterView, slotSelect } from './dashboard.service.js';
import { thresholdsOf } from './dashboard.settings.js';
import { absentDaysOf, activeSinceOf, classSignalsOf, signalWindowsOf, slotFactsOf } from './dashboard.signals.js';

// The Homeroom Teacher's Class view (dashboard ticket 03, the spec's D1, D2 and D8): the Class
// across every Subject of the current Semester, each Student placed in it now with their
// attendance, their running grade per Subject and their Support Signals. Read live: one
// Class is about a dozen slots, read SLOTS_AT_ONCE at a time.
//
// Owner's decisions (2026-10-26, the spec; 2026-10-27, the plan, through the picker):
// - Read by the Class's Homeroom Teacher, the Principal and the Vice Principals, as the
//   Notes and the promotions are. Anyone else gets a missing Class's 404, and a Student is
//   hidden from the route.
// - Attendance: the whole Semester, every confirmed Session of the Student's, the Class
//   they sat in before a move included - attendanceSummary's Semester row, the number the
//   member detail shows.
// - Grades: each slot's grade book, so they equal its grade view; below the KKTP by the
//   slot's own KKTP.
// - Signals: each slot's content and grade signals, naming its Subject; FREQUENT_ABSENCE
//   by days with an ABSENT, whatever the Subject (the owner's pick, against counting per
//   Subject) but in the current Semester only, and INACTIVE across the Class's slots, naming
//   none (dashboard.signals.js).
// - The Class's own line: the Students placed now, those with a signal, and those below
//   the KKTP in at least one Subject.
// - The current Semester (currentTermOf). A Class of another year answers semester null
//   and nothing else, as the teacher's view does once the year is closed.

const CLASS_NOT_FOUND = 'Class not found';

const classSelect = { id: true, name: true, academicYearId: true, academicYear: { select: { label: true } } };

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const classView = (row) => ({ id: row.id, name: row.name, academicYear: row.academicYear.label });

const attendanceView = (counts) => ({ ...counts, percent: percentOf(counts.present, counts.counted) });

// A Student's grade in one slot: the final grade, whether it is under the slot's KKTP,
// and how many Assessments still wait. No grade where another Class's slot reports them.
function gradeView({ slot, facts }, studentProfileId) {
    const { book } = facts;
    const grade = book.reporting.isReportedHere(studentProfileId) ? book.gradeOf(studentProfileId) : null;
    const finalGrade = grade?.finalGrade?.value ?? null;
    return {
        classSubjectId: slot.id,
        finalGrade,
        belowKktp: finalGrade !== null && finalGrade < book.settings.kktp.value,
        waiting: grade?.waiting ?? 0,
    };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// The Class, for its Homeroom Teacher, the Principal or a Vice Principal; anyone else,
// another school's member included, gets the 404 of a missing one.
async function loadClass(auth, classId) {
    const found = await prisma.class.findFirst({ where: { id: classId }, select: classSelect });
    if (!found) throw notFound(CLASS_NOT_FOUND);
    const reads = (await isHomeroomOf(auth.membershipId, found.id)) || (await isPrincipalOrVice(auth.membershipId));
    if (!reads) throw notFound(CLASS_NOT_FOUND);
    return found;
}

// One slot of the Class over the Students placed in it now: their progress and the slot's
// facts, the grade book among them.
async function slotOfClass(auth, slot, placed, windows) {
    const [progress, facts] = await Promise.all([progressOf(slot, placed), slotFactsOf(auth, slot, windows)]);
    return { slot, progress, facts };
}

// GET /api/dashboard/classes/:id. Read only, but the grade books read attempts, which
// closes one past its deadline, as every read of them does (assessment ticket 03).
async function classDashboard(auth, classId) {
    const homeroom = await loadClass(auth, classId);
    const now = new Date();
    const [term, thresholds] = await Promise.all([currentTermOf(auth.schoolId), thresholdsOf()]);
    const answer = {
        class: classView(homeroom),
        semester: null,
        thresholds,
        subjects: [],
        summary: null,
        students: [],
    };
    if (!term.semester || term.year.id !== homeroom.academicYearId) return answer;

    const windows = await signalWindowsOf(auth.schoolId, thresholds, now);
    const [names, rows] = await Promise.all([
        placedNowIn(homeroom.id),
        prisma.classSubject.findMany({
            where: { classId: homeroom.id, semesterId: term.semester.id, status: 'ACTIVE' },
            select: { ...slotSelect, endedAt: true },
        }),
    ]);
    const placed = [...names.keys()];
    const [slots, attendance, absentDays, activeSince] = await Promise.all([
        mapAtMost(orderedSlotsOf(rows), SLOTS_AT_ONCE, (slot) => slotOfClass(auth, slot, placed, windows)),
        attendanceCounts(placed, { classSubject: { semesterId: term.semester.id } }),
        absentDaysOf(term.semester.id, placed, windows),
        activeSinceOf(auth, homeroom.id, term.semester, placed),
    ]);

    const students = placed
        .map((studentProfileId) => ({
            studentProfileId,
            fullName: names.get(studentProfileId),
            attendance: attendanceView(attendance.get(studentProfileId)),
            grades: slots.map((entry) => gradeView(entry, studentProfileId)),
            signals: classSignalsOf(studentProfileId, { slots, absentDays, activeSince, thresholds, windows }),
        }))
        .sort(byName);

    return {
        ...answer,
        semester: semesterView(term),
        subjects: slots.map(({ slot, facts }) => ({
            classSubjectId: slot.id,
            subject: slot.subject,
            kktp: facts.book.settings.kktp.value,
        })),
        summary: {
            studentsPlacedNow: students.length,
            withSignal: students.filter((student) => student.signals.length > 0).length,
            belowKktpSomewhere: students.filter((student) => student.grades.some((grade) => grade.belowKktp)).length,
        },
        students,
    };
}

export { classDashboard };
