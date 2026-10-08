// Automatic marking (assessment ticket 03): the points an answer earns on an
// objective question, a draft until release (ticket 04). Pure - it is given the
// copy with its key and the answer, and reads nothing - so marking a Submission when
// it closes and marking it again after a key fix give the same result.
//
// Owner's decisions (2026-10-04):
// - MCQ SINGLE: the one correct option, alone. ALL_OR_NOTHING: exactly the correct
//   set. PARTIAL: (correct chosen - wrong chosen) / correct x points, never below 0,
//   so ticking everything earns no more than the rule allows.
// - TF: the key's value.
// - SHORT: one of the accepted answers, ignoring letter case, outer spaces and
//   repeated spaces (defaults taken 1).
// - ESSAY: the teacher's (ticket 04), so nothing here.

// Four decimal places, as SubmissionAnswer.autoPoints holds them (2026-10-08).
const PLACES = 10_000;

const round = (points) => Math.round(points * PLACES) / PLACES;

// "  Jakarta " and "jakarta" are one answer.
const normalizeShort = (text) => (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));

function mcqPoints({ mcqScoring, answerKey, points }, optionIds) {
    const correct = new Set(answerKey.correctOptionIds);
    const chosen = new Set(optionIds);
    if (mcqScoring !== 'PARTIAL') return sameSet(chosen, correct) ? points : 0;

    const right = [...chosen].filter((optionId) => correct.has(optionId)).length;
    const wrong = chosen.size - right;
    return (Math.max(0, right - wrong) / correct.size) * points;
}

const MARKERS = {
    MCQ: (question, answer) => mcqPoints(question, answer.optionIds),
    TF: (question, answer) => (answer.value === question.answerKey.value ? question.points : 0),
    SHORT: (question, answer) => {
        const given = normalizeShort(answer.text);
        return given && question.answerKey.accepted.some((accepted) => normalizeShort(accepted) === given)
            ? question.points
            : 0;
    },
};

// question: { kind, mcqScoring, answerKey, points }, the Assessment's copy. answer:
// { optionIds, value, text } as saved. Null for an ESSAY.
function autoPointsOf(question, answer) {
    const mark = MARKERS[question.kind];
    return mark ? round(mark(question, answer)) : null;
}

export { autoPointsOf, normalizeShort };
