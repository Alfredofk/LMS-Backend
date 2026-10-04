import { prisma } from '../../shared/prisma.js';
import { currentPlacement } from '../../shared/guards.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { distanceMeters } from '../../shared/geo.js';
import { createLogger } from '../../lib/helpers.js';
import { answeringTeacherOf, staffStandingOf, sessionSelect, loadSession, describeSession } from '../sessions/sessions.service.js';
import { recordEvent } from '../tracking/tracking.record.js';

const log = createLogger('Attendance');

// Attendance per Session (teaching-and-learning ticket 03): Hadir, Sakit, Izin
// or Alpa for each student.
//
// Owner's decisions (2026-09-27 and 2026-09-30):
// - The student checks in; the teacher confirms. Check-in opens at the Session's
//   start and closes at its end, or when the teacher confirms if that is sooner.
//   After the first 30 minutes it is accepted and flagged late.
// - The device's location is checked against the school's point with a fixed
//   150 m radius, accepted and flagged outsideSchool beyond it. Only the flags are
//   stored: no coordinates, no distance, and nothing of either in a log line.
// - The location is a signal; the teacher's confirmation is the control. On it,
//   everyone who did not check in becomes ABSENT, and the teacher may set any
//   status. Every change the teacher makes is kept (AttendanceChange).
// - Confirming is "the meeting happened": it clears a Session's needs-completion
//   mark (ticket 09), and a Session past with no check-ins is filled in by hand
//   this way.
// - The teacher who confirms is the one who answers for the Session: its own
//   ClassSubject's, or the successor's once that ended (answeringTeacherOf). A
//   Session between an ending and a successor takes check-ins, and waits.
//
// Learning Events (ticket 05): a check-in writes attendance.checked_in, with its
// two flags and nothing of the location, and a confirmation attendance.confirmed -
// each in the same transaction as the attendance it records.

const CHECK_IN_RADIUS_M = 150;
const LATE_AFTER_MS = 30 * 60 * 1000;
const MIN_NOTE_LENGTH = 3;

// Who reads a Session's attendance: its staff - the teacher who answers for it,
// the Principal and Vice Principals, and the Class's homeroom teacher
// (staffStandingOf). Anyone else - another school included - gets 404.
async function canRead(auth, session) {
    return Boolean(await staffStandingOf(auth, session.classSubject));
}

async function assertCanRead(auth, session) {
    if (!(await canRead(auth, session))) throw notFound('Session not found');
}

// Only the teacher who answers for it confirms or corrects. A reader who is not
// that teacher gets 403; anyone else 404.
async function assertAnswers(auth, session) {
    if ((await answeringTeacherOf(session.classSubject)) === auth.membershipId) return;
    if (await canRead(auth, session)) {
        throw forbidden('Only the teacher of this class subject confirms its attendance');
    }
    throw notFound('Session not found');
}

// The Class's students placed at the Session's start - not those placed after it,
// and still those who moved away since.
async function rosterOf(session) {
    const placements = await prisma.classMembership.findMany({
        where: {
            classId: session.classSubject.classId,
            startedAt: { lte: session.startsAt },
            OR: [{ endedAt: null }, { endedAt: { gt: session.startsAt } }],
        },
        select: { studentProfileId: true },
    });
    return [...new Set(placements.map((placement) => placement.studentProfileId))];
}

const attendanceView = (row) => ({
    id: row.id,
    studentProfileId: row.studentProfileId,
    status: row.status,
    checkedInAt: row.checkedInAt,
    outsideSchool: row.outsideSchool,
    late: row.late,
});

const sessionView = (session) => ({
    id: session.id,
    number: session.number,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    status: session.status,
    needsCompletion: session.needsCompletion,
    confirmed: session.completedAt !== null,
    completedAt: session.completedAt,
    classSubjectId: session.classSubject.id,
    // The name alone repeats from year to year: classId and academicYear tell a
    // student's two 7As apart (2026-10-03).
    classId: session.classSubject.classId,
    class: session.classSubject.class.name,
    academicYear: session.classSubject.class.academicYear.label,
    subject: session.classSubject.subject,
});

// ---------------------------------------------------------------------------
// The student's check-in
// ---------------------------------------------------------------------------

async function checkIn(auth, sessionId, { latitude, longitude }) {
    const session = await loadSession(sessionId);
    const placement = await currentPlacement(auth.membershipId);
    if (!placement || placement.classId !== session.classSubject.classId) {
        throw notFound('Session not found');
    }

    const now = new Date();
    if (session.status !== 'SCHEDULED') throw conflict(`${describeSession(session)} was cancelled`);
    if (session.completedAt) throw conflict('The teacher has already confirmed this attendance');
    if (now < session.startsAt) throw conflict('Check-in opens when the session starts');
    if (now >= session.endsAt) throw conflict('The session has ended, so check-in is closed');

    // School is above tenancy, so this reads without a scope.
    const school = await prisma.school.findUnique({
        where: { id: auth.schoolId },
        select: { latitude: true, longitude: true },
    });
    if (school?.latitude == null || school?.longitude == null) {
        throw conflict('This school has no location set, so your teacher records attendance');
    }

    const outsideSchool = distanceMeters(school, { latitude, longitude }) > CHECK_IN_RADIUS_M;
    const late = now.getTime() - session.startsAt.getTime() > LATE_AFTER_MS;

    let row;
    try {
        row = await prisma.$transaction(async (tx) => {
            const created = await tx.attendance.create({
                data: {
                    sessionId: session.id,
                    studentProfileId: placement.studentProfileId,
                    status: 'PRESENT',
                    checkedInAt: now,
                    outsideSchool,
                    late,
                },
            });
            // The two flags only - never the location or a distance (spec invariant 3).
            await recordEvent(tx, {
                actorMembershipId: auth.membershipId,
                verb: 'attendance.checked_in',
                objectType: 'Session',
                objectId: session.id,
                context: { attendanceId: created.id, classSubjectId: session.classSubject.id, late, outsideSchool },
                occurredAt: now,
            });
            return created;
        });
    } catch (error) {
        if (error?.code !== 'P2002') throw error;
        // The row is there already: the student's own check-in, or an Alpa the
        // teacher's confirmation wrote since the checks above.
        const existing = await prisma.attendance.findFirst({
            where: { sessionId: session.id, studentProfileId: placement.studentProfileId },
            select: { checkedInAt: true },
        });
        throw conflict(
            existing?.checkedInAt
                ? 'You have already checked in'
                : 'The teacher has already confirmed this attendance'
        );
    }

    const flags = [late && 'late', outsideSchool && 'outside the school'].filter(Boolean);
    log.info(`Check-in to ${describeSession(session)}${flags.length ? ` (${flags.join(', ')})` : ''}`);
    return { session: sessionView(session), attendance: attendanceView(row) };
}

// ---------------------------------------------------------------------------
// The teacher's confirmation, and corrections after it
// ---------------------------------------------------------------------------

async function confirm(auth, sessionId, { statuses = [] }) {
    const session = await loadSession(sessionId);
    await assertAnswers(auth, session);

    const now = new Date();
    if (session.status !== 'SCHEDULED') throw conflict(`${describeSession(session)} was cancelled`);
    if (session.startsAt > now) throw conflict(`${describeSession(session)} has not begun yet`);
    if (session.completedAt) throw conflict('This attendance has already been confirmed');

    const roster = await rosterOf(session);
    const named = new Set();
    for (const entry of statuses) {
        if (!roster.includes(entry.studentProfileId)) {
            throw badRequest('Every student named must be in this class at this session');
        }
        if (named.has(entry.studentProfileId)) throw badRequest('A student is named twice');
        named.add(entry.studentProfileId);
    }

    await prisma.$transaction(async (tx) => {
        // Claimed once: the meeting happened, and a needs-completion mark clears.
        const claimed = await tx.session.updateMany({
            where: { id: session.id, status: 'SCHEDULED', completedAt: null },
            data: { completedAt: now, completedByUserId: auth.userId, needsCompletion: false },
        });
        if (claimed.count === 0) throw conflict('This attendance has already been confirmed');

        const existing = await tx.attendance.findMany({
            where: { sessionId: session.id },
            select: { studentProfileId: true },
        });
        const checkedIn = new Set(existing.map((row) => row.studentProfileId));
        const absent = roster.filter((studentProfileId) => !checkedIn.has(studentProfileId));
        // skipDuplicates: a check-in landing in the same moment keeps its PRESENT.
        const marked = await tx.attendance.createMany({
            data: absent.map((studentProfileId) => ({ sessionId: session.id, studentProfileId, status: 'ABSENT' })),
            skipDuplicates: true,
        });

        let changed = 0;
        for (const entry of statuses) {
            const row = await tx.attendance.findFirst({
                where: { sessionId: session.id, studentProfileId: entry.studentProfileId },
                select: { id: true, status: true },
            });
            if (row.status === entry.status) continue;

            await tx.attendance.updateMany({ where: { id: row.id }, data: { status: entry.status } });
            await tx.attendanceChange.create({
                data: {
                    attendanceId: row.id,
                    fromStatus: row.status,
                    toStatus: entry.status,
                    note: entry.note?.trim() || null,
                    changedByUserId: auth.userId,
                },
            });
            changed += 1;
        }

        await recordEvent(tx, {
            actorMembershipId: auth.membershipId,
            verb: 'attendance.confirmed',
            objectType: 'Session',
            objectId: session.id,
            context: { classSubjectId: session.classSubject.id, markedAbsent: marked.count, changed },
            occurredAt: now,
        });
    });

    log.info(`${describeSession(session)} confirmed${session.needsCompletion ? ', filled in after the fact' : ''}`);
    return rosterView(auth, sessionId);
}

// A correction after confirmation: any status, with a note, kept as a change.
async function correct(auth, attendanceId, { status, note }) {
    const row = await prisma.attendance.findFirst({
        where: { id: attendanceId },
        select: { id: true, status: true, sessionId: true },
    });
    if (!row) throw notFound('Attendance not found');
    const session = await loadSession(row.sessionId);
    await assertAnswers(auth, session);

    if (!session.completedAt) throw conflict('Confirm the attendance first');
    const trimmed = note?.trim() ?? '';
    if (trimmed.length < MIN_NOTE_LENGTH) throw badRequest('A note is required for a correction');
    if (row.status === status) throw badRequest(`It is ${status} already`);

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.attendance.updateMany({
            where: { id: row.id, status: row.status },
            data: { status },
        });
        if (claimed.count === 0) throw conflict('This attendance changed meanwhile');

        await tx.attendanceChange.create({
            data: {
                attendanceId: row.id,
                fromStatus: row.status,
                toStatus: status,
                note: trimmed,
                changedByUserId: auth.userId,
            },
        });
    });

    log.info(`Attendance corrected in ${describeSession(session)}: ${row.status} -> ${status}`);
    const updated = await prisma.attendance.findFirst({ where: { id: row.id } });
    return attendanceView(updated);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// A Session's roster: every student placed at its start, and anyone else with a
// row - a student moved into the Class after it began, who then checked in. Before
// confirmation a student who has not checked in has no status yet.
async function rosterView(auth, sessionId) {
    const session = await loadSession(sessionId);
    await assertCanRead(auth, session);

    const roster = await rosterOf(session);
    const rows = await prisma.attendance.findMany({ where: { sessionId: session.id } });
    const byStudent = new Map(rows.map((row) => [row.studentProfileId, row]));
    const ids = [...new Set([...roster, ...byStudent.keys()])];

    const profiles = await prisma.studentProfile.findMany({
        where: { id: { in: ids } },
        select: { id: true, membership: { select: { user: { select: { fullName: true } } } } },
    });
    const nameOf = new Map(profiles.map((profile) => [profile.id, profile.membership.user.fullName]));

    const students = ids
        .map((studentProfileId) => {
            const row = byStudent.get(studentProfileId);
            return {
                studentProfileId,
                fullName: nameOf.get(studentProfileId) ?? null,
                attendanceId: row?.id ?? null,
                status: row?.status ?? null,
                checkedInAt: row?.checkedInAt ?? null,
                outsideSchool: row?.outsideSchool ?? false,
                late: row?.late ?? false,
            };
        })
        .sort((a, b) => (a.fullName ?? '').localeCompare(b.fullName ?? ''));

    return { session: sessionView(session), students };
}

// One record's changes, oldest first, for the same readers as the roster.
async function history(auth, attendanceId) {
    const row = await prisma.attendance.findFirst({ where: { id: attendanceId } });
    if (!row) throw notFound('Attendance not found');
    const session = await loadSession(row.sessionId);
    if (!(await canRead(auth, session))) throw notFound('Attendance not found');

    const changes = await prisma.attendanceChange.findMany({
        where: { attendanceId },
        orderBy: { createdAt: 'asc' },
    });
    // User is above tenancy: the names of who changed what.
    const users = await prisma.user.findMany({
        where: { id: { in: [...new Set(changes.map((change) => change.changedByUserId))] } },
        select: { id: true, fullName: true },
    });
    const nameOf = new Map(users.map((user) => [user.id, user.fullName]));

    return {
        attendance: attendanceView(row),
        changes: changes.map((change) => ({
            id: change.id,
            fromStatus: change.fromStatus,
            toStatus: change.toStatus,
            note: change.note,
            changedBy: { userId: change.changedByUserId, fullName: nameOf.get(change.changedByUserId) ?? null },
            at: change.createdAt,
        })),
    };
}

// A student's own attendance, oldest Session first: every record of theirs at
// this school, whatever Class it was taken in. A class move or a new academic year
// does not hide the old ones (owner, 2026-10-02); each Session names its Class.
async function mine(auth, { classSubjectId }) {
    const profile = await prisma.studentProfile.findFirst({
        where: { membershipId: auth.membershipId, endedAt: null },
        select: { id: true },
    });
    if (!profile) return [];

    const rows = await prisma.attendance.findMany({
        where: {
            studentProfileId: profile.id,
            ...(classSubjectId ? { session: { classSubjectId } } : {}),
        },
        include: { session: { select: sessionSelect } },
        orderBy: { session: { startsAt: 'asc' } },
    });

    return rows.map(({ session, ...row }) => ({ ...attendanceView(row), session: sessionView(session) }));
}

// ---------------------------------------------------------------------------
// Counts, for the school's leaders and the progress views
// ---------------------------------------------------------------------------

// One rule for every count of a student's attendance: the member detail's
// (registration-and-membership ticket 22) and the progress views'
// (teaching-and-learning 06), so a student's numbers agree in both.
//
// - Confirmed Sessions only. A check-in writes PRESENT at once, but ABSENT is
//   written only at confirmation, so an unconfirmed Session would overstate the
//   rate. A Session cancelled after the fact - NOT_HELD after a check-in, say -
//   is left out, whatever rows it carries.
// - late and outsideSchool are counted on PRESENT rows only: a check-in the
//   teacher corrected to another status no longer counts as late.
//
// The student's own numbers, with nothing to compare them against: no class
// average, no rank (handoff #21).
const CONFIRMED_SESSION = { status: 'SCHEDULED', completedAt: { not: null } };

const STATUS_COUNT = { PRESENT: 'present', SICK: 'sick', EXCUSED: 'excused', ABSENT: 'absent' };

const noCounts = () => ({ counted: 0, present: 0, sick: 0, excused: 0, absent: 0, late: 0, outsideSchool: 0 });

function tally(counts, row) {
    counts.counted += 1;
    counts[STATUS_COUNT[row.status]] += 1;
    if (row.status === 'PRESENT' && row.late) counts.late += 1;
    if (row.status === 'PRESENT' && row.outsideSchool) counts.outsideSchool += 1;
}

// A student's counts over one academic year, a row per Semester
// (registration-and-membership ticket 22, owner 2026-10-04). Called by
// membership's member detail; the caller has already decided who may read it.
//
// A Session counts under its ClassSubject's Semester, not under a Class: a student
// who moved Class during the year keeps the weeks in the first one.
async function attendanceSummary(studentProfileId, academicYearId) {
    const [semesters, rows] = await Promise.all([
        prisma.semester.findMany({
            where: { academicYearId },
            select: { id: true, ordinal: true },
            orderBy: { ordinal: 'asc' },
        }),
        prisma.attendance.findMany({
            where: {
                studentProfileId,
                session: { ...CONFIRMED_SESSION, classSubject: { semester: { academicYearId } } },
            },
            select: {
                status: true,
                late: true,
                outsideSchool: true,
                session: { select: { classSubject: { select: { semesterId: true } } } },
            },
        }),
    ]);

    const bySemester = new Map(
        semesters.map((semester) => [
            semester.id,
            { semesterId: semester.id, ordinal: semester.ordinal, ...noCounts() },
        ])
    );
    for (const row of rows) {
        const counts = bySemester.get(row.session.classSubject.semesterId);
        if (counts) tally(counts, row);
    }
    return [...bySemester.values()];
}

// Several students' counts over the Sessions the caller names - a slot's, for the
// progress views (teaching-and-learning 06) - confirmed ones only, as above. Every
// student asked for has an entry, all zero when nothing counted. The caller has
// already decided who may read it.
async function attendanceCounts(studentProfileIds, sessionWhere) {
    const rows = await prisma.attendance.findMany({
        where: {
            studentProfileId: { in: studentProfileIds },
            session: { ...sessionWhere, ...CONFIRMED_SESSION },
        },
        select: { studentProfileId: true, status: true, late: true, outsideSchool: true },
    });

    const byStudent = new Map(studentProfileIds.map((studentProfileId) => [studentProfileId, noCounts()]));
    for (const row of rows) tally(byStudent.get(row.studentProfileId), row);
    return byStudent;
}

// Each student's latest check-in among the Sessions the caller names, confirmed or
// not, for the progress views' last activity (teaching-and-learning 06). A student
// who never checked in there has no entry.
async function lastCheckIns(studentProfileIds, sessionWhere) {
    const rows = await prisma.attendance.groupBy({
        by: ['studentProfileId'],
        where: { studentProfileId: { in: studentProfileIds }, checkedInAt: { not: null }, session: sessionWhere },
        _max: { checkedInAt: true },
    });
    return new Map(rows.map((row) => [row.studentProfileId, row._max.checkedInAt]));
}

export {
    checkIn,
    confirm,
    correct,
    rosterView,
    history,
    mine,
    CONFIRMED_SESSION,
    attendanceSummary,
    attendanceCounts,
    lastCheckIns,
};
