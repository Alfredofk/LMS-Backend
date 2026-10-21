import { prisma } from '../../shared/prisma.js';
import { isFinalGrade, nextGradeLevel } from '../../shared/schoolType.js';

// The Promotion Outcome's rules (grading-and-report-card ticket 09): which outcomes a
// Class may be given, who is promoted without a decision, and what an even Semester's
// Report Card says. Shared by the Homeroom Teacher's reads and writes
// (grading.promotion.js), the readiness board (grading.finalising.js) and the close
// (grading.close.js), so it imports none of them.
//
// Owner's decisions (2026-10-20, the ticket and its build plan):
// - Decided once a year, in the even Semester, by the Homeroom Teacher of the Class a
//   Student is placed in now, for the Students who get its Report Card - the Notes'.
// - A Student whose every Final Grade reaches its KKTP is promoted without a decision
//   ("langsung anggap sebagai naik kelas"), and on the top grade graduates. Reaching
//   is >= - the KKTP is the mark of mastery. "Every" reads both Semesters, as the Report
//   Card's statement does ("semester 1 dan 2"): the even one's Final Grades, at least
//   one, and every grade on the Student's newest Report Card of the odd one, where they
//   have one. None is automatic while the odd Semester is not closed.
// - The Homeroom Teacher's own outcome always wins, RETAINED over an automatic
//   promotion included; cleared, the automatic one applies again.
// - The choices: PROMOTED or RETAINED below the top grade, GRADUATED or RETAINED on it.

const EVEN = 2;

const isEvenSemester = (semester) => semester.ordinal === EVEN;

// The outcomes a Class of this grade level may be given, the advancing one first.
const choicesOf = (school, gradeLevel) =>
    isFinalGrade(school.schoolType, gradeLevel, school.durationYears)
        ? ['GRADUATED', 'RETAINED']
        : ['PROMOTED', 'RETAINED'];

// The outcome of a Student promoted without a decision: PROMOTED, GRADUATED on the top grade.
const automaticOutcomeOf = (school, gradeLevel) => choicesOf(school, gradeLevel)[0];

// What counts for a Student: their Homeroom Teacher's own outcome, else the automatic
// one, else null - undecided.
const resultOf = (own, automatic, school, gradeLevel) =>
    own ?? (automatic ? automaticOutcomeOf(school, gradeLevel) : null);

// The columns an even Semester's Report Card freezes for an outcome.
const promotionColumnsOf = (school, gradeLevel, outcome) => ({
    promotionOutcome: outcome,
    nextGradeLevel: nextGradeLevel(school.schoolType, gradeLevel, outcome, school.durationYears),
});

// Each Final Grade a slot's grade book reports, with its KKTP, of the Students named -
// or of all it reports: [{ studentProfileId, finalGrade, kktp }].
function gradesReportedBy(book, studentProfileIds = null) {
    return book.roster.studentProfileIds
        .filter((id) => book.reporting.isReportedHere(id) && (!studentProfileIds || studentProfileIds.has(id)))
        .map((studentProfileId) => ({
            studentProfileId,
            finalGrade: book.gradeOf(studentProfileId).finalGrade?.value ?? null,
            kktp: book.settings.kktp.value,
        }));
}

const reachesKktp = (line) => line.finalGrade !== null && line.finalGrade >= line.kktp;

// Of these Students, the ones promoted without a decision, given the even Semester's
// grades, [{ studentProfileId, finalGrade, kktp }]: at least one, every one reaching its
// KKTP, and every grade on their newest Report Card of the odd Semester too.
async function automaticallyPromotedOf(semester, studentProfileIds, grades) {
    const ids = [...studentProfileIds];
    const odd = await prisma.semester.findFirst({
        where: { academicYearId: semester.academicYearId, ordinal: 1 },
        select: { id: true, status: true },
    });
    if (odd && odd.status !== 'CLOSED') return new Set();
    const cards = odd
        ? await prisma.reportCard.findMany({
            where: { semesterId: odd.id, studentProfileId: { in: ids } },
            select: { studentProfileId: true, version: true, subjects: { select: { finalGrade: true, kktp: true } } },
        })
        : [];
    const newest = new Map();
    for (const card of cards) {
        if ((newest.get(card.studentProfileId)?.version ?? 0) < card.version) newest.set(card.studentProfileId, card);
    }
    const evenOf = new Map();
    for (const line of grades) evenOf.set(line.studentProfileId, [...(evenOf.get(line.studentProfileId) ?? []), line]);

    return new Set(
        ids.filter((studentProfileId) => {
            const even = evenOf.get(studentProfileId) ?? [];
            const odds = newest.get(studentProfileId)?.subjects ?? [];
            return even.length > 0 && even.every(reachesKktp) && odds.every(reachesKktp);
        })
    );
}

// The Homeroom Teachers' own outcomes, on the open placements of these Students in the
// Classes given - placedIn maps a Student to their Class: a Map of the placement rows,
// { id, studentProfileId, outcome, updatedAt }, by Student. Read in a transaction when
// a client is given.
async function ownOutcomesOf(placedIn, client = prisma) {
    const rows = await client.classMembership.findMany({
        where: { studentProfileId: { in: [...placedIn.keys()] }, endedAt: null },
        select: { id: true, classId: true, studentProfileId: true, outcome: true, updatedAt: true },
    });
    const placed = rows.filter((row) => placedIn.get(row.studentProfileId) === row.classId);
    return new Map(placed.map((row) => [row.studentProfileId, row]));
}

export {
    isEvenSemester,
    choicesOf,
    automaticOutcomeOf,
    resultOf,
    promotionColumnsOf,
    gradesReportedBy,
    automaticallyPromotedOf,
    ownOutcomesOf,
};
