import { prisma } from '../../shared/prisma.js';
import { isPrincipalOrVice, isHomeroomOf } from '../../shared/guards.js';
import { notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { answeringTeacherOf } from '../sessions/sessions.service.js';
import { CONFIRMED_SESSION, attendanceCounts } from '../attendance/attendance.service.js';
import { readableByStudent, studentProfileOf } from '../content/content.service.js';
import { CONTENT_ORDER } from '../content/content.moves.js';
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
                const { recorded } = await recordContentEvent(tx, {
                    actorMembershipId: auth.membershipId,
                    studentProfileId,
                    content: target.content,
                    session: target.session,
                    verb: event.verb,
                    occurredAt,
                    position: event.position,
                    duration: event.duration,
                });
                results[index] = { index, ok: true, recorded };
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
// - Its Content is what a student of the Class can read: published and not
//   deleted, in any Session of the slot, a cancelled one included. A draft or a
//   deleted Content counts for no one.
// - Opened is a progress row of any kind - every event stamps firstOpenedAt -
//   and completed is its completedAt.
// - Attendance counts confirmed Sessions only, by attendance's own rule
//   (attendanceCounts), so it agrees with the member detail.
// - The last activity is the latest progress row's or check-in's.
// - Nothing comparative reaches a student: their view is their own row, the one
//   their teacher sees, with no peer's numbers, no average and no rank (spec
//   invariant 7, handoff #21). The Principal's aggregate by Class and Subject
//   waits for the dashboard spec (handoff #25).

const PUBLISHED = { publishedAt: { not: null }, deletedAt: null };

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
    semester: { select: { id: true, ordinal: true } },
};

// The Sessions of a ClassSubject's slot: its own, and those of every other ACTIVE
// row in the same Class, Subject and Semester, ended ones included.
const sessionsOfSlot = (classSubject) => ({
    classSubject: {
        classId: classSubject.classId,
        subjectId: classSubject.subjectId,
        semesterId: classSubject.semesterId,
        status: 'ACTIVE',
    },
});

const latest = (a, b) => (!a || (b && b > a) ? b : a);

// Each student's own row over a slot - Content opened and completed out of what is
// published, attendance, the last activity - and, per Content, how many of these
// students opened and completed it, which only the staff's view shows. The
// guardian view (a later spec) reads a child's row through here too.
async function progressOf(classSubject, studentProfileIds) {
    const sessionWhere = sessionsOfSlot(classSubject);
    const contents = await prisma.content.findMany({
        where: { ...PUBLISHED, session: sessionWhere },
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
        prisma.attendance.groupBy({
            by: ['studentProfileId'],
            where: { studentProfileId: { in: studentProfileIds }, checkedInAt: { not: null }, session: sessionWhere },
            _max: { checkedInAt: true },
        }),
    ]);

    const students = new Map(
        studentProfileIds.map((studentProfileId) => [
            studentProfileId,
            {
                contents: { published: contents.length, opened: 0, completed: 0 },
                attendance: attendance.get(studentProfileId),
                lastActivityAt: null,
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
    for (const row of checkIns) {
        const student = students.get(row.studentProfileId);
        student.lastActivityAt = latest(student.lastActivityAt, row._max.checkedInAt);
    }

    return { contents, byContent, students };
}

const classSubjectView = (classSubject) => ({
    id: classSubject.id,
    class: { id: classSubject.class.id, name: classSubject.class.name },
    academicYear: classSubject.class.academicYear.label,
    subject: classSubject.subject,
    semester: classSubject.semester,
});

// Who reads a slot's progress per student: the teacher who answers for it, the
// Principal and Vice Principals, and the Class's homeroom teacher - the readers of
// its attendance (owner, 2026-10-04).
async function mayReadProgress(auth, classSubject) {
    if ((await answeringTeacherOf(classSubject)) === auth.membershipId) return true;
    if (await isPrincipalOrVice(auth.membershipId)) return true;
    return isHomeroomOf(auth.membershipId, classSubject.classId);
}

// One ClassSubject's progress, per student and per Content. The roster is the
// students placed in the Class now: one who moved away keeps their rows, unshown,
// and one who arrived shows what they did since. Anyone the slot does not concern,
// another school included, gets 404, and so does a ClassSubject never ACTIVE.
async function classSubjectProgress(auth, classSubjectId) {
    const classSubject = await prisma.classSubject.findFirst({
        where: { id: classSubjectId, status: 'ACTIVE' },
        select: slotSelect,
    });
    if (!classSubject || !(await mayReadProgress(auth, classSubject))) {
        throw notFound('Class subject not found');
    }

    const placements = await prisma.classMembership.findMany({
        where: { classId: classSubject.classId, endedAt: null, studentProfile: { endedAt: null } },
        select: {
            studentProfileId: true,
            studentProfile: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
        },
    });
    const nameOf = new Map(
        placements.map((placement) => [placement.studentProfileId, placement.studentProfile.membership.user.fullName])
    );
    const ids = [...nameOf.keys()];

    const [{ contents, byContent, students }, confirmedSessions] = await Promise.all([
        progressOf(classSubject, ids),
        prisma.session.count({ where: { ...sessionsOfSlot(classSubject), ...CONFIRMED_SESSION } }),
    ]);

    return {
        classSubject: classSubjectView(classSubject),
        confirmedSessions,
        rosterSize: ids.length,
        contents: contents.map((content) => ({
            id: content.id,
            title: content.title,
            type: content.type,
            session: content.session,
            publishedAt: content.publishedAt,
            ...byContent.get(content.id),
        })),
        students: ids
            .map((studentProfileId) => ({
                studentProfileId,
                fullName: nameOf.get(studentProfileId),
                ...students.get(studentProfileId),
            }))
            .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    };
}

// A student's own progress in each ClassSubject of the Class they sit in now - the
// ones GET /api/academics/me/class-subjects lists - each over its whole slot. Their
// row alone: the numbers their teacher sees for them, and nothing of anyone else.
async function ownProgress(auth) {
    const placement = await prisma.classMembership.findFirst({
        where: { endedAt: null, studentProfile: { membershipId: auth.membershipId, endedAt: null } },
        select: { classId: true, studentProfileId: true, class: { select: { id: true, name: true } } },
    });
    if (!placement) return { class: null, classSubjects: [] };

    const classSubjects = await prisma.classSubject.findMany({
        where: { classId: placement.classId, status: 'ACTIVE', endedAt: null },
        select: slotSelect,
        orderBy: [{ semester: { ordinal: 'asc' } }, { subject: { code: 'asc' } }],
    });

    const rows = await Promise.all(
        classSubjects.map(async (classSubject) => {
            const { students } = await progressOf(classSubject, [placement.studentProfileId]);
            return {
                classSubjectId: classSubject.id,
                subject: classSubject.subject,
                semester: classSubject.semester,
                ...students.get(placement.studentProfileId),
            };
        })
    );
    return { class: placement.class, classSubjects: rows };
}

export { recordClientEvents, classSubjectProgress, ownProgress };
