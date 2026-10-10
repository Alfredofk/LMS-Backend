// Scores (assessment ticket 04): the marks a Score is made from, and the one writer
// of Score - as tracking.record.js is of LearningEvent. Every function takes the
// client, so it joins its caller's transaction.
//
// Owner's decisions (2026-10-04, and the build decisions of 2026-10-09):
// - A Score is 0-100: the points earned / the total of the questions the Submission
//   showed x 100, two decimals, the raw points kept too. An OFFLINE mark is 0-100 as
//   entered.
// - An answer earns the teacher's points when they gave some - an ESSAY's mark, or a
//   SHORT's automatic one overridden - and its automatic points otherwise. An
//   unanswered question earns 0.
// - An ESSAY left empty, neither text nor file, counts 0 and waits for no teacher
//   (2026-10-09); every other ESSAY answer waits for the teacher's points before
//   its Submission may be released.
// - Recorded at release; after that a Score never changes (handoff #26). A
//   correction is a new row with its reason, the old one stays, and the newest
//   counts. The database refuses UPDATE and DELETE by a trigger (_add_scores).
// - A correction is written only where the mark changed (2026-10-09): a key fixed
//   after release corrects the Students it moves, and leaves the rest alone. The raw
//   points are the mark too (2026-10-10): 0 of 10 that became 0 of 15 is corrected,
//   and so are answers whose points the teacher moved though the sum stayed.
// - The Score that counts for a Student is the highest of the newest Scores of
//   their released Submissions not void.
// - A question's points changed: the teacher's points on it keep their share of the
//   question (2026-10-09). An ESSAY of 10 marked 8, lowered to 5, becomes 4.

// Four decimal places for points, as SubmissionAnswer holds them; two for a Score.
const POINT_PLACES = 10_000;
const SCORE_PLACES = 100;

const roundPoints = (points) => Math.round(points * POINT_PLACES) / POINT_PLACES;
const roundScore = (value) => Math.round(value * SCORE_PLACES) / SCORE_PLACES;

// A Decimal column read back, as a number, or null.
const numberOf = (decimal) => (decimal === null || decimal === undefined ? null : Number(decimal));

// What a mark is computed from, of a Submission.
const markedSubmissionSelect = { id: true, closedBy: true, shownOrder: true, offlineMark: true };

const answerMarkSelect = {
    submissionId: true,
    assessmentQuestionId: true,
    text: true,
    fileStorageKey: true,
    autoPoints: true,
    teacherPoints: true,
};

const scoreSelect = {
    id: true,
    submissionId: true,
    value: true,
    pointsEarned: true,
    pointsTotal: true,
    reason: true,
    recordedAt: true,
    recordedByUserId: true,
};

// An ESSAY with neither text nor file (2026-10-09).
const isEmptyEssay = (answer) => !answer?.text?.trim() && !answer?.fileStorageKey;

// What an answer earns. No row is an unanswered question.
const pointsOf = (answer) => numberOf(answer?.teacherPoints) ?? numberOf(answer?.autoPoints) ?? 0;

// Whether an ESSAY answer still waits for the teacher's points.
const needsMarking = (kind, answer) => kind === 'ESSAY' && !isEmptyEssay(answer) && answer.teacherPoints === null;

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

function onlineMarkOf(submission, copyById, answerOf) {
    let earned = 0;
    let total = 0;
    let unmarked = 0;
    for (const questionId of submission.shownOrder.questions) {
        const copy = copyById.get(questionId);
        const answer = answerOf(submission.id, questionId);
        total += copy.points;
        earned += pointsOf(answer);
        if (needsMarking(copy.kind, answer)) unmarked += 1;
    }
    return {
        value: total ? roundScore((earned / total) * 100) : 0,
        pointsEarned: roundPoints(earned),
        pointsTotal: total,
        unmarked,
    };
}

const offlineMarkOf = (submission) => ({
    value: numberOf(submission.offlineMark),
    pointsEarned: null,
    pointsTotal: null,
    unmarked: submission.offlineMark === null ? 1 : 0,
});

// Each closed Submission's mark as it stands, by id: { value, pointsEarned,
// pointsTotal, unmarked } - unmarked counting the ESSAY answers that wait for the
// teacher. The submissions are read with markedSubmissionSelect.
async function marksOf(client, submissions) {
    const online = submissions.filter((submission) => submission.closedBy !== 'TEACHER');
    const questionIds = [...new Set(online.flatMap((submission) => submission.shownOrder.questions))];
    const copies = await client.assessmentQuestion.findMany({
        where: { id: { in: questionIds } },
        select: { id: true, kind: true, points: true },
    });
    const answers = await client.submissionAnswer.findMany({
        where: { submissionId: { in: online.map((submission) => submission.id) } },
        select: answerMarkSelect,
    });

    const copyById = new Map(copies.map((copy) => [copy.id, copy]));
    const keyOf = (submissionId, questionId) => `${submissionId}:${questionId}`;
    const answerByKey = new Map(
        answers.map((answer) => [keyOf(answer.submissionId, answer.assessmentQuestionId), answer])
    );
    const answerOf = (submissionId, questionId) => answerByKey.get(keyOf(submissionId, questionId));
    const markOf = (submission) =>
        submission.closedBy === 'TEACHER' ? offlineMarkOf(submission) : onlineMarkOf(submission, copyById, answerOf);
    return new Map(submissions.map((submission) => [submission.id, markOf(submission)]));
}

// ---------------------------------------------------------------------------
// Reading Scores
// ---------------------------------------------------------------------------

// Each Submission's Scores, oldest first, by id: the last is the one that counts.
async function scoresOf(client, submissionIds) {
    const rows = await client.score.findMany({
        where: { submissionId: { in: submissionIds } },
        select: scoreSelect,
        orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    });
    const bySubmission = new Map();
    for (const row of rows) {
        if (!bySubmission.has(row.submissionId)) bySubmission.set(row.submissionId, []);
        bySubmission.get(row.submissionId).push(row);
    }
    return bySubmission;
}

const currentScoreOf = (scores, submissionId) => scores.get(submissionId)?.at(-1) ?? null;

// The Score that counts for one Student: the highest current Score of their released
// Submissions not void, or null - "did not submit", or nothing released yet, is not 0.
function countedScoreOf(submissions, scores) {
    const values = submissions
        .filter((submission) => submission.releasedAt && !submission.voidedAt)
        .map((submission) => currentScoreOf(scores, submission.id))
        .filter(Boolean)
        .map((score) => Number(score.value));
    return values.length ? Math.max(...values) : null;
}

const scoreView = (row) =>
    row && {
        value: Number(row.value),
        pointsEarned: numberOf(row.pointsEarned),
        pointsTotal: row.pointsTotal,
        reason: row.reason,
        recordedAt: row.recordedAt,
    };

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// The only write of a Score. Its time is taken here, inside the caller's transaction
// and after its claim, so a correction that waited for another lands after it and is
// the newest.
const recordScore = (tx, submissionId, mark, { reason = null, userId }) =>
    tx.score.create({
        data: {
            submissionId,
            value: mark.value,
            pointsEarned: mark.pointsEarned,
            pointsTotal: mark.pointsTotal,
            reason,
            recordedAt: new Date(),
            recordedByUserId: userId,
        },
        select: { id: true },
    });

// The value and both raw points (owner, 2026-10-10): a question's points raised keeps
// a Student with 0 at 0, yet their 0 of 10 is now 0 of 15.
const sameAsScore = (mark, score) =>
    score !== null &&
    Number(score.value) === mark.value &&
    numberOf(score.pointsEarned) === mark.pointsEarned &&
    score.pointsTotal === mark.pointsTotal;

// The released Submissions among `where`, marked again: a correction, with the
// reason, for each whose mark changed (2026-10-09). Returns how many. `pointsMoved`
// says the caller moved an answer's points by hand, which is recorded even where the
// sum stays: an essay's 10 and another's 0 swapped is still 10 of 20, yet the change
// and its reason are kept (owner, 2026-10-10). The caller has claimed them, so
// marking or a release at the same moment waits.
async function correctReleased(tx, where, { reason, userId, pointsMoved = false }) {
    const released = await tx.submission.findMany({
        where: { ...where, releasedAt: { not: null }, voidedAt: null },
        select: markedSubmissionSelect,
    });
    if (!released.length) return 0;
    const ids = released.map((submission) => submission.id);
    const marks = await marksOf(tx, released);
    const scores = await scoresOf(tx, ids);

    let corrected = 0;
    for (const submission of released) {
        const mark = marks.get(submission.id);
        if (!pointsMoved && sameAsScore(mark, currentScoreOf(scores, submission.id))) continue;
        await recordScore(tx, submission.id, mark, { reason, userId });
        corrected += 1;
    }
    return corrected;
}

// An Assessment's closed Submissions not void, held for this transaction: a key or
// points fix takes them before it marks again, as marking and a release do.
const claimClosedSubmissions = (tx, assessmentId, now) =>
    tx.submission.updateMany({
        where: { assessmentId, submittedAt: { not: null }, voidedAt: null },
        data: { updatedAt: now },
    });

// A question's points changed from `from` to `to`: the teacher's points on it keep
// their share of the question (2026-10-09), so 8 of 10 lowered to 5 is 4, and raised
// to 20 is 16. changes: [{ id, from, to }], by AssessmentQuestion id.
async function scaleTeacherPoints(tx, changes) {
    let scaled = 0;
    for (const { id, from, to } of changes) {
        const marked = await tx.submissionAnswer.findMany({
            where: { assessmentQuestionId: id, teacherPoints: { not: null } },
            select: { id: true, teacherPoints: true },
        });
        for (const answer of marked) {
            await tx.submissionAnswer.updateMany({
                where: { id: answer.id },
                data: { teacherPoints: roundPoints((Number(answer.teacherPoints) * to) / from) },
            });
        }
        scaled += marked.length;
    }
    return scaled;
}

export {
    markedSubmissionSelect,
    numberOf,
    isEmptyEssay,
    pointsOf,
    needsMarking,
    marksOf,
    scoresOf,
    currentScoreOf,
    countedScoreOf,
    scoreView,
    recordScore,
    correctReleased,
    claimClosedSubmissions,
    scaleTeacherPoints,
};
