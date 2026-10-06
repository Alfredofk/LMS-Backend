import { prisma } from '../../shared/prisma.js';
import { notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { staffStandingOf, semesterSpan } from '../sessions/sessions.service.js';
import { CONFIRMED_SESSION, attendanceCounts, lastCheckIns } from '../attendance/attendance.service.js';
import { readableByStudent, studentProfileOf } from '../content/content.service.js';
import { CONTENT_ORDER } from '../content/content.moves.js';
import { READABLE_BY_STUDENT } from '../content/content.summary.js';
import { liveClassSubjectsOfStudent } from '../academics/academics.service.js';
import { CONTENT_VERBS, recordContentEvent } from './tracking.record.js';

const log = createLogger('Tracking');

// A student's own Learning Events, sent by the frontend in batches
// (teaching-and-learning ticket 05). What each verb means, and what it completes,
// is tracking.record.js's.
//
// - The actor is the caller: the token's membership, never anything in the body.
// - Each Content must be one the student reaches now: published, live, under a
//   Session of the Class they sit in (readableByStudent). Every miss - a draft,
//   another Class's, another school's, one that is gone - is the same "Content not
//   found", so the route answers nothing about what exists.
// - occurredAt is the device's, bounded: no more than 5 minutes ahead (a clock
//   running fast), no more than a day old.
// - Every accepted event, with the progress it moves, is written in one
//   transaction.
// - Always 200, with an answer per event, as a bulk approval answers: a batch is
//   not lost for one stale item, and the frontend learns which one it was.
// - An accepted event's answer says whether its Content is now complete for the
//   student (`completed`), so the frontend ticks it at once (ticket 06 follow-up,
//   owner 2026-10-04).

const MAX_AHEAD_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CONTENT_NOT_FOUND = 'Content not found';

const refused = (index, code, message) => ({ index, ok: false, error: { code, message } });

async function recordClientEvents(auth, { events }) {
    const receivedAt = new Date();
    const studentProfileId = await studentProfileOf(auth);

    // Each Content is looked up once, however many events name it.
    const reach = new Map();
    const reachOf = async (contentId) => {
        if (!reach.has(contentId)) reach.set(contentId, await readableByStudent(auth, contentId));
        return reach.get(contentId);
    };

    const results = new Array(events.length);
    const accepted = [];
    for (const [index, event] of events.entries()) {
        const occurredAt = event.occurredAt ?? receivedAt;
        if (occurredAt.getTime() > receivedAt.getTime() + MAX_AHEAD_MS) {
            results[index] = refused(index, 'BAD_REQUEST', 'occurredAt is in the future');
            continue;
        }
        if (occurredAt.getTime() < receivedAt.getTime() - MAX_AGE_MS) {
            results[index] = refused(index, 'BAD_REQUEST', 'occurredAt is more than a day old');
            continue;
        }

        const target = studentProfileId ? await reachOf(event.contentId) : null;
        if (!target) {
            results[index] = refused(index, 'NOT_FOUND', CONTENT_NOT_FOUND);
            continue;
        }
        if (!CONTENT_VERBS[event.verb].fits(target.content)) {
            const message = `${event.verb} does not apply to this ${target.content.type}`;
            results[index] = refused(index, 'BAD_REQUEST', message);
            continue;
        }
        accepted.push({ index, event, occurredAt, target });
    }

    if (accepted.length > 0) {
        await prisma.$transaction(async (tx) => {
            for (const { index, event, occurredAt, target } of accepted) {
                const { recorded, completed } = await recordContentEvent(tx, {
                    actorMembershipId: auth.membershipId,
                    studentProfileId,
                    content: target.content,
                    session: target.session,
                    verb: event.verb,
                    occurredAt,
                    position: event.position,
                    duration: event.duration,
                });
                results[index] = { index, ok: true, recorded, completed };
            }
        });
    }

    const summary = {
        recorded: results.filter((entry) => entry.ok && entry.recorded).length,
        notRecorded: results.filter((entry) => entry.ok && !entry.recorded).length,
        refused: results.filter((entry) => !entry.ok).length,
    };
    log.info(`Learning events at ${auth.schoolName}: ${summary.recorded} recorded, ${summary.refused} refused`);
    return { results, summary };
}

// ---------------------------------------------------------------------------
// Progress views (ticket 06)
// ---------------------------------------------------------------------------

// The first readers of what is recorded above (teaching-and-learning ticket 06,
// owner 2026-10-04). Built from ContentProgress and Attendance only: a Learning
// Event is never scanned on read (handoff #24).
//
// - A view covers a ClassSubject's whole slot - its Class, Subject and Semester -
//   so a successor teacher also sees the Sessions an ended assignment left there,
//   the ones they already answer for (answeringTeacherOf).
// - Its Content is what a student of the Class can read (READABLE_BY_STUDENT), in
//   any Session of the slot, a cancelled one included. A draft or a deleted
//   Content counts for no one.
// - Opened is a progress row of any kind - every event stamps firstOpenedAt -
//   and completed is its completedAt.
// - Attendance counts confirmed Sessions only, by attendance's own rule
//   (attendanceCounts), so it agrees with the member detail.
// - The last activity is the latest progress row's or check-in's (lastCheckIns).
// - Nothing comparative reaches a student: their view is their own row, the one
//   their teacher sees, with no peer's numbers, no average and no rank (spec
//   invariant 7, handoff #21). The Principal's aggregate by Class and Subject
//   waits for the dashboard spec (handoff #25).

const slotSelect = {
    id: true,
    status: true,
    endedAt: true,
    classId: true,
    subjectId: true,
    semesterId: true,
    teacherMembershipId: true,
    class: { select: { id: true, name: true, academicYear: { select: { label: true } } } },
    subject: { select: { code: true, name: true } },
    semester: { select: { id: true, ordinal: true, startDate: true, endDate: true } },
};

// The where of a slot's Sessions: its own ClassSubject's, and those of every other
// ACTIVE row in the same Class, Subject and Semester, ended ones included.
const slotSessionWhere = (classSubject) => ({
    classSubject: {
        classId: classSubject.classId,
        subjectId: classSubject.subjectId,
        semesterId: classSubject.semesterId,
        status: 'ACTIVE',
    },
});

const semesterView = (semester) => ({ id: semester.id, ordinal: semester.ordinal });

const latest = (a, b) => (!a || (b && b > a) ? b : a);

// Each student's own row over a slot - Content opened and completed out of what is
// published, attendance, the last activity - and, per Content, how many of these
// students opened and completed it, which only the staff's view shows. The
// guardian view (a later spec) reads a child's row through here too.
async function progressOf(classSubject, studentProfileIds) {
    const sessionWhere = slotSessionWhere(classSubject);
    const contents = await prisma.content.findMany({
        where: { ...READABLE_BY_STUDENT, session: sessionWhere },
        select: {
            id: true,
            title: true,
            type: true,
            publishedAt: true,
            session: { select: { id: true, number: true } },
        },
        orderBy: [{ session: { startsAt: 'asc' } }, { session: { number: 'asc' } }, ...CONTENT_ORDER],
    });

    const [progress, attendance, checkIns] = await Promise.all([
        prisma.contentProgress.findMany({
            where: {
                contentId: { in: contents.map((content) => content.id) },
                studentProfileId: { in: studentProfileIds },
            },
            select: { contentId: true, studentProfileId: true, lastActivityAt: true, completedAt: true },
        }),
        attendanceCounts(studentProfileIds, sessionWhere),
        lastCheckIns(studentProfileIds, sessionWhere),
    ]);

    const students = new Map(
        studentProfileIds.map((studentProfileId) => [
            studentProfileId,
            {
                contents: { published: contents.length, opened: 0, completed: 0 },
                attendance: attendance.get(studentProfileId),
                lastActivityAt: checkIns.get(studentProfileId) ?? null,
            },
        ])
    );
    const byContent = new Map(contents.map((content) => [content.id, { opened: 0, completed: 0 }]));
    for (const row of progress) {
        const student = students.get(row.studentProfileId);
        const content = byContent.get(row.contentId);
        student.contents.opened += 1;
        content.opened += 1;
        if (row.completedAt) {
            student.contents.completed += 1;
            content.completed += 1;
        }
        student.lastActivityAt = latest(student.lastActivityAt, row.lastActivityAt);
    }

    return { contents, byContent, students };
}

// A slot's roster (owner, 2026-10-04, from the review of this ticket): every
// student placed in the Class at any time in the Semester, and anyone else with a
// progress row or an attendance in the slot - one who joined in the second
// Semester may still have opened the first one's Content. One who moved away or
// left stays, placedNow false: the record is the slot's, and a past year's view
// keeps its students once Rollover ends their placements. The per-Content counts
// therefore match ContentProgress. The attendance roster keeps its own the same
// way (rosterView).
async function rosterOf(auth, classSubject) {
    const { start, end } = await semesterSpan(auth.schoolId, classSubject.semester);
    const sessionWhere = slotSessionWhere(classSubject);
    const [placements, progressed, attended] = await Promise.all([
        prisma.classMembership.findMany({
            where: {
                classId: classSubject.classId,
                startedAt: { lt: end },
                OR: [{ endedAt: null }, { endedAt: { gt: start } }],
            },
            select: { studentProfileId: true, endedAt: true },
        }),
        prisma.contentProgress.findMany({
            where: { content: { ...READABLE_BY_STUDENT, session: sessionWhere } },
            select: { studentProfileId: true },
            distinct: ['studentProfileId'],
        }),
        prisma.attendance.findMany({
            where: { session: sessionWhere },
            select: { studentProfileId: true },
            distinct: ['studentProfileId'],
        }),
    ]);
    const studentProfileIds = [
        ...new Set([...placements, ...progressed, ...attended].map((row) => row.studentProfileId)),
    ];

    const profiles = await prisma.studentProfile.findMany({
        where: { id: { in: studentProfileIds } },
        select: { id: true, endedAt: true, membership: { select: { user: { select: { fullName: true } } } } },
    });
    const live = new Set(profiles.filter((profile) => profile.endedAt === null).map((profile) => profile.id));
    const open = new Set(
        placements.filter((placement) => placement.endedAt === null).map((placement) => placement.studentProfileId)
    );
    return {
        studentProfileIds,
        nameOf: new Map(profiles.map((profile) => [profile.id, profile.membership.user.fullName])),
        placedNow: (studentProfileId) => open.has(studentProfileId) && live.has(studentProfileId),
    };
}

const classSubjectView = (classSubject) => ({
    id: classSubject.id,
    class: { id: classSubject.class.id, name: classSubject.class.name },
    academicYear: classSubject.class.academicYear.label,
    subject: classSubject.subject,
    semester: semesterView(classSubject.semester),
});

// One ClassSubject's progress, per student and per Content, for its staff: the
// teacher who answers for it, the Principal and Vice Principals, and the Class's
// homeroom teacher (staffStandingOf - the readers of its attendance, owner
// 2026-10-04). Anyone else, another school included, gets 404, and so does a
// ClassSubject never ACTIVE.
async function classSubjectProgress(auth, classSubjectId) {
    const classSubject = await prisma.classSubject.findFirst({
        where: { id: classSubjectId, status: 'ACTIVE' },
        select: slotSelect,
    });
    if (!classSubject || !(await staffStandingOf(auth, classSubject))) {
        throw notFound('Class subject not found');
    }

    const roster = await rosterOf(auth, classSubject);
    const [{ contents, byContent, students }, confirmedSessions] = await Promise.all([
        progressOf(classSubject, roster.studentProfileIds),
        prisma.session.count({ where: { ...slotSessionWhere(classSubject), ...CONFIRMED_SESSION } }),
    ]);

    return {
        classSubject: classSubjectView(classSubject),
        confirmedSessions,
        rosterSize: roster.studentProfileIds.length,
        contents: contents.map((content) => ({
            id: content.id,
            title: content.title,
            type: content.type,
            session: content.session,
            publishedAt: content.publishedAt,
            ...byContent.get(content.id),
        })),
        students: roster.studentProfileIds
            .map((studentProfileId) => ({
                studentProfileId,
                fullName: roster.nameOf.get(studentProfileId) ?? null,
                placedNow: roster.placedNow(studentProfileId),
                ...students.get(studentProfileId),
            }))
            .sort((a, b) => (a.fullName ?? '').localeCompare(b.fullName ?? '')),
    };
}

// A student's own progress in each live ClassSubject of the Class they sit in now
// (liveClassSubjectsOfStudent), each over its whole slot - so an ended assignment's
// Content counts under its successor's row. Not an earlier Class's, which their
// subjects list for reading only (teaching-and-learning 12, owner 2026-10-06). Their
// row alone: the numbers their teacher sees for them, and nothing of anyone else.
async function ownProgress(auth) {
    const { placement, rows } = await liveClassSubjectsOfStudent(auth.membershipId, slotSelect);
    if (!placement) return { class: null, classSubjects: [] };

    const classSubjects = await Promise.all(
        rows.map(async (classSubject) => {
            const { students } = await progressOf(classSubject, [placement.studentProfileId]);
            return {
                classSubjectId: classSubject.id,
                subject: classSubject.subject,
                semester: semesterView(classSubject.semester),
                ...students.get(placement.studentProfileId),
            };
        })
    );
    return { class: placement.class, classSubjects };
}

export { recordClientEvents, classSubjectProgress, ownProgress };
