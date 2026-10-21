// Final grades (grading-and-report-card ticket 02): a Student's Scores turned into one
// grade per Subject. Pure - it is given the Scores that count, the weights, the KKTP
// and the school's Remedial Rule, and reads nothing - so the slot's grade view, the
// Student's own reads and the Report Card (ticket 05) compute the same number. It
// never writes a Score (spec invariant 2).
//
// Owner's decisions (2026-10-13, the spec, and the build decisions of 2026-10-14):
// - The Remedial Rule applies per Assessment, where the remedial attempts reach a
//   higher Score than the ordinary ones: the original is the highest ordinary Score,
//   the remedial the highest remedial one. The cap is max(original, min(remedial,
//   KKTP)), min(remedial, KKTP) with no original; the highest is the remedial; the
//   average is (original + remedial) / 2, or the remedial alone with no original.
// - Inside a type, the plain average of its Assessments that count. A type with none
//   that counts for this Student drops out, and the rest are scaled up in proportion:
//   20/20/35 with no UTS is 26.67/26.67/46.67. A type weighted 0 counts for nothing.
// - The weighted sum is kept exact and rounded once, half up, to a whole number: 80.55
//   is 81, 84.5 is 85. Exact because 84.5 summed in floating point may come out as
//   84.4999... and round down. The unrounded sum is shown cut to two decimals, never
//   rounded, so 84.4999 never reads 84.50 beside a grade of 84.

// The four types in the order every view lists them.
const TYPES = ['TUGAS', 'KUIS', 'UTS', 'UAS'];

// A Score has two decimals and an average of two has three: thousandths hold them whole.
const MILLI = 1000;

const toMilli = (value) => Math.round(value * MILLI);

// num / den, both whole and not negative, rounded half up.
const roundHalfUp = (num, den) => (2n * num + den) / (2n * den);

// A share in hundredths, half up: 170 / 3 is 56.67.
const hundredthsOf = (num, den) => Number(roundHalfUp(num * 100n, den)) / 100;

const highestOf = (values) => (values.length ? Math.max(...values) : null);

const AFTER_RULE = {
    CAP_AT_KKTP: (original, remedial, kktp) =>
        original === null ? Math.min(remedial, kktp) : Math.max(original, Math.min(remedial, kktp)),
    HIGHEST: (_original, remedial) => remedial,
    AVERAGE: (original, remedial) => (original === null ? remedial : toMilli((original + remedial) / 2) / MILLI),
};

// ---------------------------------------------------------------------------
// One Assessment
// ---------------------------------------------------------------------------

// What one Assessment counts for a Student, from the Scores that count on it - each
// { remedial, value } - and whether the Remedial Rule moved it off the Score that
// counts (the highest). Null when none counts.
function ruleResultOf(counting, rule, kktp) {
    if (!AFTER_RULE[rule]) throw new Error(`unknown remedial rule ${rule}`);
    const original = highestOf(counting.filter((score) => !score.remedial).map((score) => score.value));
    const remedial = highestOf(counting.filter((score) => score.remedial).map((score) => score.value));
    if (original === null && remedial === null) return null;
    if (remedial === null || (original !== null && remedial <= original)) return { value: original, moved: false };

    const value = AFTER_RULE[rule](original, remedial, kktp);
    return { value, moved: value !== remedial };
}

// What a Student's own reads carry beside the raw Score (owner, 2026-10-14): the result
// after the Remedial Rule, and the rule, where the rule moves it; else null.
function afterRuleOf(counting, { rule, kktp }) {
    const result = ruleResultOf(counting, rule, kktp);
    return result?.moved ? { score: result.value, rule } : null;
}

// ---------------------------------------------------------------------------
// The final grade
// ---------------------------------------------------------------------------

// A Student's grade from what counts on each Assessment, [{ type, value }], and the
// slot's weights: each type's average with the weight it carries once the types with
// nothing that counts drop out, and the final grade, or null while nothing weighted
// counts. Each average comes in hundredths and rounded, the whole number the Report
// Card prints (ticket 08): rounded once from the exact sum, as the final grade is, so
// 84.4967 is 84 although its hundredths read 84.50.
function finalGradeOf(entries, weights) {
    const sums = new Map();
    for (const { type, value } of entries) {
        const sum = sums.get(type) ?? { total: 0n, count: 0n };
        sums.set(type, { total: sum.total + BigInt(toMilli(value)), count: sum.count + 1n });
    }
    const weighted = TYPES.filter((type) => sums.has(type) && weights[type] > 0);
    const weightTotal = BigInt(weighted.reduce((total, type) => total + weights[type], 0));

    const typeView = (type) => {
        const sum = sums.get(type);
        if (!sum) return null;
        return {
            average: hundredthsOf(sum.total, sum.count * BigInt(MILLI)),
            rounded: Number(roundHalfUp(sum.total, sum.count * BigInt(MILLI))),
            weight: weighted.includes(type) ? hundredthsOf(BigInt(weights[type]) * 100n, weightTotal) : 0,
            count: Number(sum.count),
        };
    };
    const types = Object.fromEntries(TYPES.map((type) => [type, typeView(type)]));
    if (weighted.length === 0) return { types, finalGrade: null };

    // The sum of weight x average / the weights, over one denominator: the product of
    // the counts, so every average stays whole.
    const counts = weighted.reduce((product, type) => product * sums.get(type).count, 1n);
    const num = weighted.reduce(
        (total, type) => total + BigInt(weights[type]) * sums.get(type).total * (counts / sums.get(type).count),
        0n
    );
    const den = counts * weightTotal * BigInt(MILLI);
    return {
        types,
        finalGrade: { unrounded: Number((num * 100n) / den) / 100, value: Number(roundHalfUp(num, den)) },
    };
}

// ---------------------------------------------------------------------------
// The letter
// ---------------------------------------------------------------------------

// The letter a Final Grade earns on the Report Card (ticket 08, owner 2026-10-20): one
// fixed scale for now. A School's own scale would be a setting frozen at close.
const LETTER_SCALE = [
    { letter: 'A', from: 90, to: 100 },
    { letter: 'B', from: 80, to: 89 },
    { letter: 'C', from: 70, to: 79 },
    { letter: 'D', from: 60, to: 69 },
    { letter: 'E', from: 0, to: 59 },
];

// The letter of a whole Final Grade, 0 to 100.
const letterOf = (grade) => LETTER_SCALE.find((band) => grade >= band.from).letter;

export { TYPES, LETTER_SCALE, ruleResultOf, afterRuleOf, finalGradeOf, letterOf };
