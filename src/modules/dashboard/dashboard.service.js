import { prisma } from '../../shared/prisma.js';
import { currentTermOf } from '../academics/academics.term.js';
import { progressOf, rosterOf } from '../tracking/tracking.service.js';
import { standingsOf } from '../assessment/assessment.marking.js';
import { assessmentSelect } from '../assessment/assessment.service.js';
import { isPractice } from '../assessment/assessment.practice.js';
import { SLOTS_AT_ONCE, mapAtMost } from '../grading/grading.finalising.js';

// What a teacher sees first (dashboard ticket 01, the spec's D1, D4 and D8): their slots of
// the current Semester, and what waits for them to mark or release. Read live: one
// teacher's slots are few, and the School-wide numbers are the rollup's (ticket 05).
//
// Owner's decisions (2026-10-26; the plan, the same day, through the picker):
// - The slots: the teacher's own live ClassSubjects of the current Semester
//   (currentTermOf), each with its Students placed now, the Content they completed and
//   their attendance at confirmed Sessions, summed from progressOf's rows and turned into a
//   percentage once - null with nothing to count. A Student who moved away no longer
//   weighs on the Class they left; the slot's own progress view still lists them.
// - The marking queue, the assessment spec's five proposals of 2026-10-11:
//   (a) the Assessments of every slot the teacher answers for now, their live rows: a
//       successor inherits what an ended assignment left (answeringTeacherOf's rule);
//   (b) counted per attempt, as an Assessment's results count them (standingsOf, which
//       closes an attempt past its deadline first), so the two always agree;
//   (c) a Principal or a Vice Principal who teaches sees their own teaching here;
//   (d) the ACTIVE years only, both Semesters;
//   (e) releasableAt: when an ONLINE one's release opens (closesAt), null once it may be
//       pressed, and on an OFFLINE one.
// - A LATIHAN is in the queue too (owner's pick): its ESSAYs wait for a comment, so it
//   counts for marking, never for release.
// - Oldest first, with oldestWaitingSince: what has waited longest is on top.

const slotSelect = {
    id: true,
    classId: true,
    subjectId: true,
    semesterId: true,
    class: { select: { id: true, name: true } },
    subject: { select: { id: true, code: true, name: true } },
    semester: { select: { id: true, ordinal: true, startDate: true, endDate: true } },
};

// The teacher's own live rows: the slots they answer for now. An ended row's slot is its
// successor's.
const OWN_LIVE_ROW = { status: 'ACTIVE', endedAt: null };

// The waiting counts are the attempts', which standingsOf lists for every Student who has
// one, on a roster or not: no roster is read for them.
const NO_ROSTER = { studentProfileIds: [], nameOf: new Map(), placedNow: () => false };

const WAITING_FOR_MARKING = 'WAITING_FOR_MARKING';
const WAITING_FOR_RELEASE = 'WAITING_FOR_RELEASE';

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const percentOf = (part, whole) => (whole ? Math.round((part * 100) / whole) : null);

const semesterView = ({ year, semester }) =>
    semester
        ? {
            id: semester.id,
            ordinal: semester.ordinal,
            academicYear: { id: year.id, label: year.label },
        }
        : null;

const slotView = (row) => ({ id: row.id, class: row.class, subject: row.subject });

// The Assessment's own slot, an ended row's included, so a successor's queue says where
// the work came from.
const queueSlotView = (classSubject) => ({
    id: classSubject.id,
    class: { id: classSubject.class.id, name: classSubject.class.name },
    subject: classSubject.subject,
    semester: { id: classSubject.semester.id, ordinal: classSubject.semester.ordinal },
    academicYear: classSubject.class.academicYear.label,
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// One slot's figures over its Students placed now.
async function slotFiguresOf(auth, slot) {
    const roster = await rosterOf(auth, slot);
    const placed = roster.studentProfileIds.filter((studentProfileId) => roster.placedNow(studentProfileId));
    const { contents, students } = await progressOf(slot, placed);

    let completed = 0;
    let present = 0;
    let counted = 0;
    for (const student of students.values()) {
        completed += student.contents.completed;
        present += student.attendance.present;
        counted += student.attendance.counted;
    }
    const possible = contents.length * placed.length;

    return {
        classSubject: slotView(slot),
        studentsPlacedNow: placed.length,
        content: { completed, possible, percent: percentOf(completed, possible) },
        attendance: { present, counted, percent: percentOf(present, counted) },
    };
}

// One Assessment's line in the queue, from its Students' standings.
function queueEntryOf(row, standings, now) {
    const waiting = standings
        .flatMap((standing) => standing.attempts)
        .filter((attempt) => attempt.status === WAITING_FOR_MARKING || attempt.status === WAITING_FOR_RELEASE);
    const count = (status) => waiting.filter((attempt) => attempt.status === status).length;
    const oldest = waiting.reduce(
        (min, attempt) => (!min || attempt.submittedAt < min ? attempt.submittedAt : min),
        null
    );
    const opensLater = !isPractice(row) && row.mode === 'ONLINE' && now < row.closesAt;

    return {
        assessment: { id: row.id, title: row.title, type: row.type, mode: row.mode, closesAt: row.closesAt },
        classSubject: queueSlotView(row.classSubject),
        marking: count(WAITING_FOR_MARKING),
        release: count(WAITING_FOR_RELEASE),
        oldestWaitingSince: oldest,
        releasableAt: opensLater ? row.closesAt : null,
    };
}

// The Assessments waiting on the teacher, oldest first. Only those with an attempt neither
// void nor released are read through standingsOf: the rest have nothing waiting.
async function queueOf(auth, now) {
    const taught = await prisma.classSubject.findMany({
        where: {
            teacherMembershipId: auth.membershipId,
            ...OWN_LIVE_ROW,
            class: { academicYear: { status: 'ACTIVE' } },
        },
        select: { classId: true, subjectId: true, semesterId: true },
    });
    if (taught.length === 0) return [];

    const rows = await prisma.assessment.findMany({
        where: {
            deletedAt: null,
            cancelledAt: null,
            publishedAt: { not: null },
            classSubject: { status: 'ACTIVE', OR: taught },
            submissions: { some: { voidedAt: null, releasedAt: null } },
        },
        select: assessmentSelect,
    });
    if (rows.length === 0) return [];

    const standings = await standingsOf(rows, NO_ROSTER, now);
    return rows
        .map((row) => queueEntryOf(row, standings.get(row.id), now))
        .filter((entry) => entry.marking + entry.release > 0)
        .sort((a, b) => a.oldestWaitingSince - b.oldestWaitingSince);
}

// GET /api/dashboard/teaching, for a member holding TEACHER: their slots of the current
// Semester with their figures, and their marking queue. Read only, but reading attempts
// closes one past its deadline, as every read of them does (assessment ticket 03).
async function teachingDashboard(auth) {
    const now = new Date();
    const term = await currentTermOf(auth.schoolId);
    const slots = term.semester
        ? await prisma.classSubject.findMany({
            where: { teacherMembershipId: auth.membershipId, ...OWN_LIVE_ROW, semesterId: term.semester.id },
            select: slotSelect,
            orderBy: [{ class: { name: 'asc' } }, { subject: { name: 'asc' } }],
        })
        : [];

    const [figures, queue] = await Promise.all([
        mapAtMost(slots, SLOTS_AT_ONCE, (slot) => slotFiguresOf(auth, slot)),
        queueOf(auth, now),
    ]);
    return { semester: semesterView(term), slots: figures, queue };
}

export { teachingDashboard };
