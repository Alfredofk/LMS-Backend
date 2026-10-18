import { prisma } from '../../shared/prisma.js';
import { isPrincipal, assertPrincipalOrVice } from '../../shared/guards.js';
import { recordAudit } from '../../shared/approval.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { answeringTeacherOf } from '../sessions/sessions.service.js';
import { byName } from '../assessment/assessment.marking.js';
import { classSubjectSelect, describe, loadForStaff } from './grading.service.js';
import { gradeBookOf, slotGrades } from './grading.grades.js';
import { blockersOf, withText, finalisedView } from './grading.readiness.js';
import { placedNowIn } from './grading.texts.js';
import { LIVE_FINALISATION, slotOf, liveFinalisationOf } from './grading.lock.js';

const log = createLogger('Grading');

// Finalising (grading-and-report-card ticket 04), the first of the Semester's two
// steps to its close (handoff #28): the Principal starts it, each slot's Answering
// Teacher finalises the slot once nothing blocks it (grading.readiness.js), and the
// Principal and the Vice Principals read the readiness board. Closing is ticket 05.
//
// Owner's decisions (2026-10-13, the spec, and the build decisions of 2026-10-18):
// - Starting finalising moves the Semester from OPEN to FINALIZING, the Principal's
//   alone (ADR-0009, the close is theirs). From then on there is no new Assessment, no
//   new teaching assignment but the leaders' override or replace naming a successor,
//   and the Semester's dates and timetables are fixed: the checks that take only OPEN
//   already say so. The Principal steps back to OPEN while no slot is finalised - to
//   shorten the Semester, say. Both steps are audited against the Semester.
// - A slot - Class x Subject x Semester - is finalised by its Answering Teacher, the
//   successor too, only while the Semester is FINALIZING and nothing blocks it; a
//   reader is told no (403), anyone else 404. It keeps the settings it was finalised
//   with, and locks (grading.lock.js) until its Teacher undoes it, which they may until
//   the Semester is CLOSED. The rows are the history; finalising is not audited.
// - Every slot with an ACTIVE ClassSubject in the Semester is to be finalised, one whose
//   Teacher left with no successor too: the board shows it with no teacher until the
//   leaders name one.
// - The Homeroom Teacher's Note is required (owner, 2026-10-18): the board names, per
//   Class, the Students placed in it now who have none. It blocks no slot; closing
//   waits for it (ticket 05).

// Starting and stopping are audited against the Semester.
const SEMESTER_SUBJECT = 'Semester';

const semesterSelect = {
    id: true,
    ordinal: true,
    status: true,
    academicYearId: true,
    academicYear: { select: { label: true, status: true } },
};

const semesterView = (semester) => ({
    id: semester.id,
    ordinal: semester.ordinal,
    status: semester.status,
    academicYear: semester.academicYear.label,
});

// 'Semester 1 of 2026/2027', for messages and log lines.
const semesterName = (semester) => `Semester ${semester.ordinal} of ${semester.academicYear.label}`;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

// A Semester of the school, with its year. Another school's is the same 404.
async function loadSemester(id) {
    const semester = await prisma.semester.findFirst({ where: { id }, select: semesterSelect });
    if (!semester) throw notFound('Semester not found');
    return semester;
}

function assertYearActive(semester) {
    if (semester.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${semester.academicYear.label} is closed`);
    }
}

// The Principal's alone (ADR-0009); a Vice Principal is told no.
async function assertPrincipal(auth, act) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden(`Only the Principal ${act}`);
}

// A slot as its Answering Teacher acts on it, the successor too; a reader is told no
// (403), anyone else gets 404 (loadForStaff). The year must be ACTIVE; what the
// Semester must be is each caller's.
async function loadForFinalising(auth, id, refusal) {
    const { classSubject, standing } = await loadForStaff(auth, id);
    if (standing !== 'teacher') throw forbidden(refusal);
    const { academicYear } = classSubject.class;
    if (academicYear.status !== 'ACTIVE') throw conflict(`Academic year ${academicYear.label} is closed`);
    return classSubject;
}

// ---------------------------------------------------------------------------
// The Semester
// ---------------------------------------------------------------------------

// OPEN -> FINALIZING, by the Principal, audited in the same transaction. Claimed, so
// starting twice is a conflict.
async function startFinalising(auth, id) {
    await assertPrincipal(auth, 'starts finalising a semester');
    const semester = await loadSemester(id);
    assertYearActive(semester);

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.semester.updateMany({
            where: { id: semester.id, status: 'OPEN' },
            data: { status: 'FINALIZING' },
        });
        if (claimed.count === 0) throw conflict(`${semesterName(semester)} is not open`);
        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: SEMESTER_SUBJECT,
            subjectId: semester.id,
            action: 'START_FINALIZING',
            actorUserId: auth.userId,
            client: tx,
        });
    });

    log.info(`${semesterName(semester)}: finalising started`);
    return semesterView(await loadSemester(id));
}

// FINALIZING -> OPEN, by the Principal, while no slot of it is finalised (owner,
// 2026-10-18): its Teachers undo theirs first. The Semester is claimed first, so a
// slot finalised at the same moment either lands before - and is counted - or finds
// the Semester open and is refused.
async function stopFinalising(auth, id) {
    await assertPrincipal(auth, 'stops finalising a semester');
    const semester = await loadSemester(id);
    assertYearActive(semester);

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.semester.updateMany({
            where: { id: semester.id, status: 'FINALIZING' },
            data: { status: 'OPEN' },
        });
        if (claimed.count === 0) throw conflict(`${semesterName(semester)} is not being finalised`);
        const finalised = await tx.slotFinalisation.count({ where: { semesterId: semester.id, ...LIVE_FINALISATION } });
        if (finalised > 0) {
            throw conflict(
                `${finalised} class subject(s) of ${semesterName(semester)} are finalised; ` +
                    'their teachers undo it first',
                { finalised }
            );
        }
        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: SEMESTER_SUBJECT,
            subjectId: semester.id,
            action: 'STOP_FINALIZING',
            actorUserId: auth.userId,
            client: tx,
        });
    });

    log.info(`${semesterName(semester)}: finalising stopped, open again`);
    return semesterView(await loadSemester(id));
}

// ---------------------------------------------------------------------------
// A slot
// ---------------------------------------------------------------------------

// The Answering Teacher finalises the slot: refused with 409, naming every blocker,
// while anything blocks it (grading.readiness.js). It keeps the settings its grades
// are computed with now. The Semester is claimed in the same transaction, so stopping
// at the same moment meets it in turn; two finalising at once meet on the partial
// unique index. Answers with the slot's grades.
async function finalise(auth, id) {
    const classSubject = await loadForFinalising(auth, id, 'Only the teacher of this class subject finalises it');
    const { semester } = classSubject;
    if (semester.status !== 'FINALIZING') {
        throw conflict(
            semester.status === 'OPEN'
                ? `Semester ${semester.ordinal} is not being finalised yet; the Principal starts it`
                : `Semester ${semester.ordinal} is closed`
        );
    }
    if (await liveFinalisationOf(classSubject)) throw conflict(`${describe(classSubject)} is finalised already`);

    const book = await gradeBookOf(auth, classSubject);
    const blockers = await blockersOf(book);
    if (blockers.length) {
        const texts = blockers.map((blocker) => blocker.text).join('; ');
        throw conflict(`${describe(classSubject)} cannot be finalised yet: ${texts}`, { blockers });
    }

    const { updatedAt: _read, ...settings } = book.settings;
    try {
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.semester.updateMany({
                where: { id: classSubject.semesterId, status: 'FINALIZING' },
                data: { updatedAt: new Date() },
            });
            if (claimed.count === 0) throw conflict(`Semester ${semester.ordinal} is no longer being finalised`);
            await tx.slotFinalisation.create({
                data: { ...slotOf(classSubject), settings, finalisedByUserId: auth.userId },
                select: { id: true },
            });
        });
    } catch (error) {
        throw error?.code === 'P2002' ? conflict(`${describe(classSubject)} is finalised already`) : error;
    }

    log.info(`${describe(classSubject)} finalised`);
    return slotGrades(auth, classSubject.id);
}

// The Answering Teacher undoes the slot's finalising while the Semester is not CLOSED:
// the row stays, undone, and the slot is open to change again. Answers with the
// slot's grades.
async function unfinalise(auth, id) {
    const classSubject = await loadForFinalising(
        auth,
        id,
        'Only the teacher of this class subject undoes its finalising'
    );
    const { semester } = classSubject;
    if (semester.status === 'CLOSED') {
        throw conflict(`Semester ${semester.ordinal} is closed; its class subjects stay finalised`);
    }

    const claimed = await prisma.slotFinalisation.updateMany({
        where: { ...slotOf(classSubject), ...LIVE_FINALISATION },
        data: { undoneAt: new Date(), undoneByUserId: auth.userId },
    });
    if (claimed.count === 0) throw conflict(`${describe(classSubject)} is not finalised`);

    log.info(`${describe(classSubject)}: finalising undone`);
    return slotGrades(auth, classSubject.id);
}

// ---------------------------------------------------------------------------
// The readiness board
// ---------------------------------------------------------------------------

// One ClassSubject per slot of the Semester: the live one, else the one that ended
// last - a slot whose Teacher left with no successor.
function slotsOf(classSubjects) {
    const bySlot = new Map();
    for (const row of classSubjects) {
        const key = `${row.classId}:${row.subjectId}`;
        const held = bySlot.get(key);
        const better = !held || (held.endedAt !== null && (row.endedAt === null || row.endedAt > held.endedAt));
        if (better) bySlot.set(key, row);
    }
    return [...bySlot.values()];
}

// One slot on the board: its Teacher, whether it is finalised, and what blocks it -
// read as finalising would, so a slot finalised and changed since (a Student moved in,
// say) shows it too. A slot nobody answers for is blocked by that first.
async function slotOnBoard(auth, classSubject, nameOf) {
    const teacherId = await answeringTeacherOf(classSubject);
    const [finalised, blockers] = await Promise.all([
        finalisedView(classSubject),
        gradeBookOf(auth, classSubject).then(blockersOf),
    ]);
    return {
        classSubjectId: classSubject.id,
        class: { id: classSubject.classId, name: classSubject.class.name },
        subject: { id: classSubject.subjectId, code: classSubject.subject.code, name: classSubject.subject.name },
        teacher: teacherId ? { membershipId: teacherId, fullName: nameOf.get(teacherId) ?? null } : null,
        finalised,
        blockers: teacherId ? blockers : [withText({ kind: 'NO_TEACHER' }), ...blockers],
    };
}

// One Class's Notes for the Semester: the Students placed in it now, and the ones of
// them with no Note - none written, or cleared (owner, 2026-10-18).
async function notesOnBoard(semester, homeroom) {
    const placed = await placedNowIn(homeroom.id);
    const written = await prisma.homeroomNote.findMany({
        where: { semesterId: semester.id, studentProfileId: { in: [...placed.keys()] }, text: { not: null } },
        select: { studentProfileId: true },
    });
    const hasNote = new Set(written.map((row) => row.studentProfileId));
    return {
        class: { id: homeroom.id, name: homeroom.name },
        homeroomTeacher: homeroom.homeroomTeacher
            ? { membershipId: homeroom.homeroomTeacher.id, fullName: homeroom.homeroomTeacher.user.fullName }
            : null,
        students: placed.size,
        missing: [...placed]
            .filter(([studentProfileId]) => !hasNote.has(studentProfileId))
            .map(([studentProfileId, fullName]) => ({ studentProfileId, fullName }))
            .sort(byName),
    };
}

// The readiness board, for the Principal and the Vice Principals: every slot of the
// Semester - finalised (by whom, when) or not, with what blocks it - and each Class of
// its year with the Notes still missing. Computed live, one slot at a time.
async function readinessBoard(auth, id) {
    await assertPrincipalOrVice(auth);
    const semester = await loadSemester(id);
    const [classSubjects, classes] = await Promise.all([
        prisma.classSubject.findMany({
            where: { semesterId: semester.id, status: 'ACTIVE' },
            select: classSubjectSelect,
        }),
        prisma.class.findMany({
            where: { academicYearId: semester.academicYearId },
            select: {
                id: true,
                name: true,
                homeroomTeacher: { select: { id: true, user: { select: { fullName: true } } } },
            },
            orderBy: { name: 'asc' },
        }),
    ]);
    const teachers = await prisma.schoolMembership.findMany({
        where: { id: { in: [...new Set(classSubjects.map((row) => row.teacherMembershipId))] } },
        select: { id: true, user: { select: { fullName: true } } },
    });
    const nameOf = new Map(teachers.map((row) => [row.id, row.user.fullName]));

    const slots = [];
    const ordered = slotsOf(classSubjects).sort(
        (a, b) => a.class.name.localeCompare(b.class.name) || a.subject.code.localeCompare(b.subject.code)
    );
    for (const classSubject of ordered) slots.push(await slotOnBoard(auth, classSubject, nameOf));
    const notes = [];
    for (const homeroom of classes) notes.push(await notesOnBoard(semester, homeroom));

    return {
        semester: semesterView(semester),
        counts: {
            slots: slots.length,
            finalised: slots.filter((slot) => slot.finalised).length,
            notesMissing: notes.reduce((sum, row) => sum + row.missing.length, 0),
        },
        slots,
        notes,
    };
}

export { startFinalising, stopFinalising, finalise, unfinalise, readinessBoard };
