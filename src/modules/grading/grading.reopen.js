import { prisma } from '../../shared/prisma.js';
import { recordAudit } from '../../shared/approval.js';
import { badRequest, conflict } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { classSubjectSelect, describe } from './grading.service.js';
import { LIVE_FINALISATION, slotOf } from './grading.lock.js';
import {
    SEMESTER_SUBJECT,
    loadSemester,
    assertYearActive,
    assertPrincipal,
    semesterName,
    semesterView,
    orderedSlotsOf,
} from './grading.finalising.js';
import { slotRef } from './grading.close.js';

const log = createLogger('Grading');

// Reopening a closed Semester (grading-and-report-card ticket 06), the explicit, audited
// way back from CLOSED (handoff #28): the Principal takes it back to FINALIZING with a
// reason, and the slots they name are unfinalised at once, so their Teachers correct and
// finalise again. Closing again (grading.close.js) writes the next version of every
// Report Card; the earlier ones stay as they were (spec invariant 3).
//
// Owner's decisions (2026-10-13, the spec, and the plan of 2026-10-19):
// - The Principal's alone (ADR-0009, handoff #37): a Vice Principal is told no. The
//   reason is required.
// - Audited in ApprovalAudit, where finalising and closing already are, so a Semester's
//   history reads in one place: REOPEN_SEMESTER against the Semester, and one against
//   each SlotFinalisation it undoes - which slots - with the same reason.
// - It may name no slot: to let a Homeroom Teacher's Note be fixed, say.
// - A Semester of a closed Academic Year stays closed (409).
// - Once it is FINALIZING again, any slot's Teacher may still undo their own finalising
//   (the spec's rule, grading.finalising.js); the slots named here are undone by the
//   reopen itself, by the Principal.
// - A Semester that has Report Cards never goes back to OPEN (stopFinalising).

// The audit row of each slot a reopen undoes names its SlotFinalisation.
const FINALISATION_SUBJECT = 'SlotFinalisation';

const notClosed = (semester) => conflict(`${semesterName(semester)} is not closed`);

const slotKeyOf = (row) => `${row.classId}:${row.subjectId}`;

// The slots these ClassSubjects name, one each, by Class then Subject: any ClassSubject
// of a slot names it, as the slot routes take them. Refuses (400) the whole request,
// naming every id that is not an active ClassSubject of this Semester.
async function namedSlotsOf(semester, classSubjectIds) {
    const ids = [...new Set(classSubjectIds)];
    if (ids.length === 0) return [];
    const rows = await prisma.classSubject.findMany({
        where: { id: { in: ids }, semesterId: semester.id, status: 'ACTIVE' },
        select: classSubjectSelect,
    });
    const found = new Set(rows.map((row) => row.id));
    const strangers = ids.filter((id) => !found.has(id));
    if (strangers.length) {
        throw badRequest(`Not a class subject of ${semesterName(semester)}: ${strangers.join(', ')}`, {
            classSubjectIds: strangers,
        });
    }
    return orderedSlotsOf(rows);
}

// Undoes the live finalisation of each slot, as the Principal, and answers the rows
// undone. A CLOSED Semester has every slot finalised and none undone while it stays so,
// so one missing is a slot that changed meanwhile: 409.
async function undoFinalisations(tx, auth, slots) {
    if (slots.length === 0) return [];
    const live = await tx.slotFinalisation.findMany({
        where: { OR: slots.map((classSubject) => slotOf(classSubject)), ...LIVE_FINALISATION },
        select: { id: true, classId: true, subjectId: true },
    });
    const isLive = new Set(live.map(slotKeyOf));
    const unfinalised = slots.filter((classSubject) => !isLive.has(slotKeyOf(classSubject)));
    if (unfinalised.length) {
        throw conflict(`Not finalised: ${unfinalised.map((classSubject) => describe(classSubject)).join(', ')}`);
    }
    const claimed = await tx.slotFinalisation.updateMany({
        where: { id: { in: live.map((row) => row.id) }, ...LIVE_FINALISATION },
        data: { undoneAt: new Date(), undoneByUserId: auth.userId },
    });
    if (claimed.count !== live.length) throw conflict('A class subject named changed meanwhile. Try again');
    return live;
}

// ---------------------------------------------------------------------------
// Reopening
// ---------------------------------------------------------------------------

// The Principal takes a CLOSED Semester of an ACTIVE year back to FINALIZING with a
// reason, unfinalising the slots named; a Vice Principal is told no (403). Refused with
// 409 for a Semester not CLOSED or a closed year, with 400 for an id not of its slots.
// The Semester, the slots and the audit land in one transaction; its Report Cards stay
// as they are. Answers with the Semester and the slots unfinalised.
async function reopenSemester(auth, id, { reason, classSubjectIds }) {
    await assertPrincipal(auth, 'reopens a semester');
    const semester = await loadSemester(id);
    assertYearActive(semester);
    if (semester.status !== 'CLOSED') throw notClosed(semester);
    const slots = await namedSlotsOf(semester, classSubjectIds);

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.semester.updateMany({
            where: { id: semester.id, status: 'CLOSED' },
            data: { status: 'FINALIZING', closedAt: null, closedByUserId: null },
        });
        if (claimed.count === 0) throw notClosed(semester);
        const undone = await undoFinalisations(tx, auth, slots);

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: SEMESTER_SUBJECT,
            subjectId: semester.id,
            action: 'REOPEN_SEMESTER',
            actorUserId: auth.userId,
            reason,
            client: tx,
        });
        for (const row of undone) {
            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: FINALISATION_SUBJECT,
                subjectId: row.id,
                action: 'REOPEN_SEMESTER',
                actorUserId: auth.userId,
                reason,
                client: tx,
            });
        }
    });

    log.info(`${semesterName(semester)} reopened: ${slots.length} class subject(s) unfinalised`);
    return { semester: semesterView(await loadSemester(id)), unfinalised: slots.map(slotRef) };
}

export { reopenSemester };
