import { prisma } from '../../shared/prisma.js';
import { badRequest, conflict, forbidden } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { byName } from '../assessment/assessment.marking.js';
import { classSubjectSelect } from './grading.service.js';
import { gradeBookOf } from './grading.grades.js';
import { LIVE_FINALISATION } from './grading.lock.js';
import { loadNotes, notedIn } from './grading.texts.js';
import { SLOTS_AT_ONCE, mapAtMost, orderedSlotsOf } from './grading.finalising.js';
import {
    isEvenSemester,
    choicesOf,
    automaticOutcomeOf,
    resultOf,
    gradesReportedBy,
    automaticallyPromotedOf,
    ownOutcomesOf,
} from './grading.promotionRule.js';

const log = createLogger('Grading');

// The Homeroom Teacher's Promotion Outcomes (grading-and-report-card ticket 09): who of
// a Class goes up a grade, stays, or graduates, decided in the even Semester and frozen
// by its close onto the Report Card (grading.close.js). The rules are in
// grading.promotionRule.js.
//
// Owner's decisions (2026-10-20, the ticket and its build plan):
// - The Notes' readers and writer: the Class's Homeroom Teacher writes, the Principal
//   and the Vice Principals read (403 on a write), anyone else gets 404. For the Notes'
//   Students: placed in the Class now and getting the Semester's Report Card.
// - Only in the even Semester, only while it is being finalised in an ACTIVE year, and
//   only once every slot of the Class is finalised: the grades are final then (409).
// - Many Students at once ("sekaligus untuk banyak student"). Each row names the outcome,
//   or null to clear it, with the updatedAt of the placement it read; one stale row
//   refuses all with 409. Stored on the open placement (ClassMembership.outcome), with who
//   and when. Not audited, as the Notes are not.
// - A Student whose every Final Grade reaches its KKTP needs no decision: the read says
//   so (automatic), and the close promotes them. A decision still wins over it.

const NOT_EVEN = 'Promotion is decided at the end of the year, in Semester 2';

const changedMeanwhile = (names) =>
    conflict(`The promotion of ${names.join(', ')} changed meanwhile. Reload and try again`);

const slotWaitingView = (classSubject) => ({
    classSubjectId: classSubject.id,
    subject: { id: classSubject.subjectId, code: classSubject.subject.code, name: classSubject.subject.name },
});

// ---------------------------------------------------------------------------
// The state of a Class's decision
// ---------------------------------------------------------------------------

// The Class's own slots of the Semester not finalised; none, and its grades are final.
async function unfinalisedSlotsOf(homeroom, semester) {
    const [classSubjects, finalisations] = await Promise.all([
        prisma.classSubject.findMany({
            where: { classId: homeroom.id, semesterId: semester.id, status: 'ACTIVE' },
            select: classSubjectSelect,
        }),
        prisma.slotFinalisation.findMany({
            where: { classId: homeroom.id, semesterId: semester.id, ...LIVE_FINALISATION },
            select: { subjectId: true },
        }),
    ]);
    const finalised = new Set(finalisations.map((row) => row.subjectId));
    return orderedSlotsOf(classSubjects).filter((classSubject) => !finalised.has(classSubject.subjectId));
}

// Why the Homeroom Teacher may not decide now, or null: the Semester not being
// finalised, the year closed, or a slot of the Class not finalised yet.
function notDecidableOf(homeroom, semester, waiting) {
    if (semester.status === 'OPEN') return 'Semester 2 is not being finalised yet';
    if (semester.status === 'CLOSED') return 'Semester 2 is closed; reopen it to change a promotion';
    if (homeroom.academicYear.status !== 'ACTIVE') return `Academic year ${homeroom.academicYear.label} is closed`;
    if (waiting.length === 0) return null;
    const names = waiting.map((classSubject) => classSubject.subject.code).join(', ');
    return `Every subject of ${homeroom.name} is finalised first; not yet: ${names}`;
}

// The even Semester's Final Grades of these Students, from the slots of every Class
// they sat in during the year - a mover's earlier Class's too - a few slots at a time.
async function evenGradesOf(auth, semester, studentProfileIds) {
    const placements = await prisma.classMembership.findMany({
        where: { studentProfileId: { in: [...studentProfileIds] }, class: { academicYearId: semester.academicYearId } },
        select: { classId: true },
    });
    const classSubjects = await prisma.classSubject.findMany({
        where: {
            semesterId: semester.id,
            status: 'ACTIVE',
            classId: { in: [...new Set(placements.map((row) => row.classId))] },
        },
        select: classSubjectSelect,
    });
    const lines = await mapAtMost(orderedSlotsOf(classSubjects), SLOTS_AT_ONCE, async (classSubject) =>
        gradesReportedBy(await gradeBookOf(auth, classSubject), studentProfileIds)
    );
    return lines.flat();
}

const schoolOf = (auth) =>
    prisma.school.findFirst({ where: { id: auth.schoolId }, select: { schoolType: true, durationYears: true } });

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

// A Class's Promotion Outcomes for the even Semester, for its Homeroom Teacher, the
// Principal and the Vice Principals: whether they may be decided now and what waits,
// the choices, and per Student their Homeroom Teacher's own outcome, whether they are
// promoted without one - known once every slot is finalised, else null - and the result.
// An odd Semester gets 409.
async function readPromotions(auth, classId, semesterId) {
    const { homeroom, semester } = await loadNotes(auth, classId, semesterId);
    if (!isEvenSemester(semester)) throw conflict(NOT_EVEN);
    const [school, placed, waiting] = await Promise.all([
        schoolOf(auth),
        notedIn(auth, homeroom, semester),
        unfinalisedSlotsOf(homeroom, semester),
    ]);
    const ids = new Set(placed.keys());
    const own = await ownOutcomesOf(new Map([...ids].map((id) => [id, homeroom.id])));
    const automatic =
        waiting.length === 0
            ? await automaticallyPromotedOf(semester, ids, await evenGradesOf(auth, semester, ids))
            : null;
    const notDecidable = notDecidableOf(homeroom, semester, waiting);

    return {
        class: { id: homeroom.id, name: homeroom.name, gradeLevel: homeroom.gradeLevel },
        academicYear: homeroom.academicYear.label,
        semester: { id: semester.id, ordinal: semester.ordinal, status: semester.status },
        decidable: notDecidable === null,
        notDecidable,
        waitingFor: waiting.map(slotWaitingView),
        choices: choicesOf(school, homeroom.gradeLevel),
        automaticOutcome: automaticOutcomeOf(school, homeroom.gradeLevel),
        students: [...placed]
            .map(([studentProfileId, fullName]) => {
                const outcome = own.get(studentProfileId)?.outcome ?? null;
                const promoted = automatic ? automatic.has(studentProfileId) : null;
                return {
                    studentProfileId,
                    fullName,
                    outcome,
                    automatic: promoted,
                    result: resultOf(outcome, promoted, school, homeroom.gradeLevel),
                    updatedAt: own.get(studentProfileId)?.updatedAt ?? null,
                };
            })
            .sort(byName),
    };
}

// The Homeroom Teacher decides the Promotion Outcomes of Students placed in their Class
// now, many at once; null clears one, back to the automatic rule. The Principal or a
// Vice Principal is told no (403), anyone else gets 404. An odd Semester, one not being
// finalised, a closed year or a slot of the Class not finalised refuses it (409); a
// Student who is not the Class's, or an outcome its grade level does not take, refuses
// the whole request with 400, naming each; a placement changed since it was read, 409.
// Answers the Class's outcomes as they now are.
async function writePromotions(auth, classId, semesterId, { promotions }) {
    const { homeroom, semester, standing } = await loadNotes(auth, classId, semesterId);
    if (standing !== 'writer') throw forbidden(`Only the Homeroom Teacher of ${homeroom.name} decides its promotions`);
    if (!isEvenSemester(semester)) throw conflict(NOT_EVEN);
    const notDecidable = notDecidableOf(homeroom, semester, await unfinalisedSlotsOf(homeroom, semester));
    if (notDecidable) throw conflict(notDecidable);

    const [school, placed] = await Promise.all([schoolOf(auth), notedIn(auth, homeroom, semester)]);
    const outside = promotions.filter((row) => !placed.has(row.studentProfileId));
    if (outside.length) {
        throw badRequest(
            `Not a student of ${homeroom.name} for Semester 2: placed elsewhere now, or after it ended`,
            { studentProfileIds: outside.map((row) => row.studentProfileId) }
        );
    }
    const choices = choicesOf(school, homeroom.gradeLevel);
    const refused = promotions.filter((row) => row.outcome !== null && !choices.includes(row.outcome));
    if (refused.length) {
        const names = refused.map((row) => placed.get(row.studentProfileId)).join(', ');
        throw badRequest(`In ${homeroom.name} a promotion is ${choices.join(' or ')}; refused for ${names}`, {
            studentProfileIds: refused.map((row) => row.studentProfileId),
            choices,
        });
    }

    const own = await ownOutcomesOf(new Map(promotions.map((row) => [row.studentProfileId, homeroom.id])));
    const stale = promotions.filter(
        (row) => own.get(row.studentProfileId)?.updatedAt.getTime() !== row.updatedAt.getTime()
    );
    if (stale.length) throw changedMeanwhile(stale.map((row) => placed.get(row.studentProfileId)));

    const changed = promotions.filter((row) => own.get(row.studentProfileId).outcome !== row.outcome);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
        for (const { studentProfileId, outcome } of changed) {
            const placement = own.get(studentProfileId);
            const claimed = await tx.classMembership.updateMany({
                where: { id: placement.id, updatedAt: placement.updatedAt, endedAt: null },
                data: {
                    outcome,
                    outcomeSetByUserId: outcome ? auth.userId : null,
                    outcomeSetAt: outcome ? now : null,
                },
            });
            if (claimed.count === 0) throw changedMeanwhile([placed.get(studentProfileId)]);
        }
    });

    if (changed.length) log.info(`Promotions of ${homeroom.name}: ${changed.length} decided`);
    return readPromotions(auth, classId, semesterId);
}

export { readPromotions, writePromotions };
