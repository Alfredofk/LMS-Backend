import { prisma } from '../../shared/prisma.js';
import { assertPrincipalOrVice } from '../../shared/guards.js';
import { currentTermOf } from '../academics/academics.term.js';
import { progressOf, rosterOf } from '../tracking/tracking.service.js';
import { byName, standingsOf } from '../assessment/assessment.marking.js';
import { assessmentSelect } from '../assessment/assessment.service.js';
import { isPractice } from '../assessment/assessment.practice.js';
import { SLOTS_AT_ONCE, mapAtMost } from '../grading/grading.finalising.js';
import { thresholdsOf } from './dashboard.settings.js';
import { signalFactsOf, signalWindowsOf, studentsNeedingSupportOf } from './dashboard.signals.js';

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
// - Each slot names its Students placed now who need support (ticket 02,
//   dashboard.signals.js), against the School's thresholds, which the answer carries.
// - The count per teacher (ticket 04, the spec's D4; the plan, 2026-10-27, through the
//   picker), for the Principal and the Vice Principals: each teacher's totals waiting for
//   marking and for release, the sums of their own queue, read live through the same
//   queueOfSlots, so the two never disagree. Measured at 3.3-3.6 s for 450 slots with every
//   attempt waiting; one standingsOf over the whole School took 9.3-10.7 s
//   (probes/04-marking-by-teacher-measure.mjs).
//   - Every teacher answering for a slot of an ACTIVE year is listed, zeros included, by
//     name: a list of the staff, not of the late.
//   - No Assessment, no Student, no other number: the owner's exception to handoff #25,
//     confined to the marking queue.
//   - What waits in a slot nobody answers for now (its teacher left or the assignment
//     ended, no successor yet) is one line beside the list, unanswered (owner's pick): a
//     School's number, not a teacher's.

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

// One slot's figures over its Students placed now, and those of them who need support.
async function slotFiguresOf(auth, slot, signalContext) {
    const roster = await rosterOf(auth, slot);
    const placed = roster.studentProfileIds.filter((studentProfileId) => roster.placedNow(studentProfileId));
    const [progress, facts] = await Promise.all([
        progressOf(slot, placed),
        signalFactsOf(auth, slot, placed, signalContext.windows),
    ]);
    const { contents, students } = progress;

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
        studentsNeedingSupport: studentsNeedingSupportOf({ roster, placed, progress, facts, ...signalContext }),
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

// The Assessments waiting on these slots, each { classId, subjectId, semesterId }, oldest
// first: a teacher's queue, and the counts per teacher (ticket 04). Only those with an
// attempt neither void nor released are read through standingsOf: the rest have nothing
// waiting.
async function queueOfSlots(slots, now) {
    if (slots.length === 0) return [];

    const rows = await prisma.assessment.findMany({
        where: {
            deletedAt: null,
            cancelledAt: null,
            publishedAt: { not: null },
            classSubject: { status: 'ACTIVE', OR: slots },
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

// The Assessments waiting on a teacher: those of every slot they answer for now, in the
// ACTIVE years.
async function queueOf(membershipId, now) {
    const taught = await prisma.classSubject.findMany({
        where: {
            teacherMembershipId: membershipId,
            ...OWN_LIVE_ROW,
            class: { academicYear: { status: 'ACTIVE' } },
        },
        select: { classId: true, subjectId: true, semesterId: true },
    });
    return queueOfSlots(taught, now);
}

// GET /api/dashboard/teaching, for a member holding TEACHER: their slots of the current
// Semester with their figures and Support Signals, the thresholds those were raised at,
// and their marking queue. Read only, but reading attempts closes one past its deadline,
// as every read of them does (assessment ticket 03).
async function teachingDashboard(auth) {
    const now = new Date();
    const [term, thresholds] = await Promise.all([currentTermOf(auth.schoolId), thresholdsOf()]);
    const windows = await signalWindowsOf(auth.schoolId, thresholds, now);
    const slots = term.semester
        ? await prisma.classSubject.findMany({
            where: { teacherMembershipId: auth.membershipId, ...OWN_LIVE_ROW, semesterId: term.semester.id },
            select: slotSelect,
            orderBy: [{ class: { name: 'asc' } }, { subject: { name: 'asc' } }],
        })
        : [];

    const [figures, queue] = await Promise.all([
        mapAtMost(slots, SLOTS_AT_ONCE, (slot) => slotFiguresOf(auth, slot, { thresholds, windows })),
        queueOf(auth.membershipId, now),
    ]);
    return { semester: semesterView(term), thresholds, slots: figures, queue };
}

// A slot as queueOfSlots takes it, and as text, to tell slots apart.
const slotKeyOf = ({ classId, subjectId, semesterId }) => ({ classId, subjectId, semesterId });
const slotTextOf = (row) => `${row.classId}:${row.subjectId}:${row.semesterId}`;

const totalsOf = (queue) => ({
    marking: queue.reduce((sum, entry) => sum + entry.marking, 0),
    release: queue.reduce((sum, entry) => sum + entry.release, 0),
});

// GET /api/dashboard/marking-by-teacher (ticket 04): each teacher's totals, the sums of their
// own queue, by name, and what waits in a slot nobody answers for now. For the Principal and
// a Vice Principal, checked against the database as the signal settings are (ADR-0009): 403
// to anyone else. Read only, but reading attempts closes one past its deadline (assessment
// ticket 03).
async function markingByTeacher(auth) {
    await assertPrincipalOrVice(auth);
    const now = new Date();
    const rows = await prisma.classSubject.findMany({
        where: { status: 'ACTIVE', class: { academicYear: { status: 'ACTIVE' } } },
        select: {
            classId: true,
            subjectId: true,
            semesterId: true,
            endedAt: true,
            teacherMembershipId: true,
            teacher: { select: { user: { select: { fullName: true } } } },
        },
    });

    // A teacher's slots are their live rows, as queueOf reads them. A slot whose rows have
    // all ended is nobody's until a successor takes it (answeringTeacherOf's rule).
    const teachers = new Map();
    const answered = new Set();
    for (const row of rows.filter((found) => found.endedAt === null)) {
        answered.add(slotTextOf(row));
        if (!teachers.has(row.teacherMembershipId)) {
            teachers.set(row.teacherMembershipId, {
                membershipId: row.teacherMembershipId,
                fullName: row.teacher.user.fullName,
                slots: [],
            });
        }
        teachers.get(row.teacherMembershipId).slots.push(slotKeyOf(row));
    }
    const unanswered = new Map(
        rows.filter((row) => !answered.has(slotTextOf(row))).map((row) => [slotTextOf(row), slotKeyOf(row)])
    );

    // The slots nobody answers for are read as one more group, last.
    const groups = [...teachers.values(), { slots: [...unanswered.values()] }];
    const totals = await mapAtMost(groups, SLOTS_AT_ONCE, async (group) =>
        totalsOf(await queueOfSlots(group.slots, now))
    );
    return {
        teachers: [...teachers.values()]
            .map(({ membershipId, fullName }, index) => ({ membershipId, fullName, ...totals[index] }))
            .sort(byName),
        unanswered: totals.at(-1),
    };
}

export { teachingDashboard, markingByTeacher, slotSelect, semesterView, percentOf };
