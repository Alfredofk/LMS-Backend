// LATIHAN (assessment ticket 08): practice a teacher sets that is never graded and
// never reaches the Report Card - formative assessment, in Kurikulum Merdeka's words.
// Its rules, read by the answering, marking, menu and grading files. It imports
// nothing of theirs, so each of them reads it without an import cycle,
// assessment.score.js included.
//
// Owner's decisions (2026-10-18, and the build decisions of the same day: "setuju"):
// - A fifth type beside TUGAS / KUIS / UTS / UAS, not a "not counted" flag on any
//   type: a UTS that does not count would be confusing.
// - ONLINE only, and it writes no Score: Score keeps meaning what counts. Its result
//   is read from its Submissions, as their marks stand.
// - The result shows at hand-in, with no release: each automatically marked
//   question's points, and the key when showKeyOnRelease is on. The total counts those
//   questions alone; a LATIHAN of ESSAYs alone shows no total, only comments.
// - An ESSAY in it takes a comment and no points, shown as soon as it is saved. Its
//   stored points count nowhere and are hidden from the Student.
// - Attempts 1 to 20, or unlimited (maxAttempts null) - unlimited for a LATIHAN alone.
// - No make-up or remedial exception, no integrity signal, no Exam Week rule; no
//   release, so no assessment.released either.
// - A Student's status on it is NOT_STARTED, IN_PROGRESS or DONE - handed in at least
//   once - for the Student and the staff alike, never DID_NOT_SUBMIT or waiting for
//   release. The menu, the outline and the staff's results show the best attempt and
//   the latest.
// - Changes after publishing follow the rules every Assessment has: what a Student is
//   shown changed voids, a key or points changed re-marks. Nothing is released, so a
//   key fix needs no reason and corrects no Score.
// - Left out of the final grades, the recap and the readiness blockers (GRADED).
// - Outside the finalising lock (grading-and-report-card 04; owner, 2026-10-18, option
//   A): the lock keeps a finalised grade from moving, and a LATIHAN has none, so its
//   teacher still comments, edits, publishes and cancels it.

const PRACTICE = 'LATIHAN';

// The Assessments a grade is made of, as a where fragment: every type but LATIHAN.
const GRADED = { type: { not: PRACTICE } };

const isPractice = (row) => row.type === PRACTICE;

// Whether a question's points count in its Assessment's total: a LATIHAN's ESSAY's
// never do.
const isInTotal = (row, question) => !isPractice(row) || question.kind !== 'ESSAY';

// An Assessment's total, from its live questions read with their kind.
const totalPointsOf = (row) =>
    row.questions.filter((question) => isInTotal(row, question)).reduce((sum, question) => sum + question.points, 0);

const isHandedIn = (submission) => submission.submittedAt !== null && submission.voidedAt === null;

// Where one Student stands on a LATIHAN, from their Submissions: DONE once one is
// handed in, though another may be under way; else IN_PROGRESS with one under way;
// else NOT_STARTED, after its window too.
function practiceStatusOf(submissions) {
    if (submissions.some(isHandedIn)) return 'DONE';
    if (submissions.some((submission) => submission.submittedAt === null && submission.voidedAt === null)) {
        return 'IN_PROGRESS';
    }
    return 'NOT_STARTED';
}

// One attempt's result as its Student reads it, in a Score's shape, so an attempt
// reads as one shape whatever its type; null with no total.
const practiceResultView = (mark) =>
    mark?.pointsTotal
        ? {
            value: mark.value,
            pointsEarned: mark.pointsEarned,
            pointsTotal: mark.pointsTotal,
            reason: null,
            recordedAt: null,
        }
        : null;

// The best attempt and the latest, of those handed in with a total, from each
// Submission's mark (marksOf in assessment.score.js); null where there is none. The
// best is the first to reach the highest value.
function practiceSummaryOf(submissions, marks) {
    const results = submissions
        .filter(isHandedIn)
        .map((submission) => ({ attempt: submission.attempt, mark: marks.get(submission.id) }))
        .filter(({ mark }) => mark?.pointsTotal)
        .map(({ attempt, mark }) => ({
            attempt,
            value: mark.value,
            pointsEarned: mark.pointsEarned,
            pointsTotal: mark.pointsTotal,
        }));
    if (results.length === 0) return { best: null, latest: null };
    return {
        best: results.reduce((best, result) => (result.value > best.value ? result : best)),
        latest: results.reduce((latest, result) => (result.attempt > latest.attempt ? result : latest)),
    };
}

export {
    PRACTICE,
    GRADED,
    isPractice,
    isInTotal,
    totalPointsOf,
    isHandedIn,
    practiceStatusOf,
    practiceResultView,
    practiceSummaryOf,
};
