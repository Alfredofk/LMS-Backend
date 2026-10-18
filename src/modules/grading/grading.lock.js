import { prisma } from '../../shared/prisma.js';
import { conflict } from '../../shared/errors.js';

// A slot's finalisation (grading-and-report-card ticket 04) as the writes under it read
// it: grading's own settings and Descriptions, and every staff write on the slot's
// Assessments (assessment.service.js, assessment.marking.js, assessment.exception.js).
// Apart from grading.finalising.js, and importing nothing of the modules, so assessment
// reads it without an import cycle: assessment.submission.js already imports grading.
//
// Owner's decisions (2026-10-13, the spec, and the build decisions of 2026-10-18):
// - A finalised slot locks its weights, its KKTP and its Descriptions, and every staff
//   write on its Assessments - their settings and window, their questions, publishing,
//   cancelling, deleting a draft, marking, release, Score corrections and exceptions:
//   409. Its Answering Teacher undoes the finalising to change any of them.
// - While finalised, the slot's grades are computed with the settings it was finalised
//   with (SlotFinalisation.settings), not the live ones.

const LIVE_FINALISATION = { undoneAt: null };

// The slot of a ClassSubject, or of anything with its three keys.
const slotOf = ({ classId, subjectId, semesterId }) => ({ classId, subjectId, semesterId });

// 'MTK in 7A, Semester 1', from a ClassSubject read with its subject's code, its
// Class's name and its Semester's ordinal - as grading's and assessment's selects are.
const slotNameOf = (classSubject) =>
    `${classSubject.subject.code} in ${classSubject.class.name}, Semester ${classSubject.semester.ordinal}`;

// The slot's live finalisation, or null.
const liveFinalisationOf = (slot) =>
    prisma.slotFinalisation.findFirst({
        where: { ...slotOf(slot), ...LIVE_FINALISATION },
        select: { id: true, settings: true, finalisedAt: true, finalisedByUserId: true },
    });

// Refuses (409) a write on a finalised slot, named by any of its ClassSubjects.
async function assertNotFinalised(classSubject) {
    if (!(await liveFinalisationOf(classSubject))) return;
    throw conflict(`${slotNameOf(classSubject)} is finalised; its teacher undoes the finalising to change it`);
}

export { LIVE_FINALISATION, slotOf, slotNameOf, liveFinalisationOf, assertNotFinalised };
