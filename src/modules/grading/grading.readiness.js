import { prisma } from '../../shared/prisma.js';
import { slotSessionWhere } from '../tracking/tracking.service.js';
import { ownTermsOf, hardEndIn, usedAttemptsOf } from '../assessment/assessment.submission.js';
import { liveFinalisationOf } from './grading.lock.js';

// What still stands between a slot and its finalising (grading-and-report-card ticket
// 04): one list, read from the slot's grade book (grading.grades.js), behind the
// finalise's 409, the slot's grade view and the readiness board, so the three never
// disagree.
//
// Owner's decisions (2026-10-13, the spec, and the build decisions of 2026-10-18):
// - A Session of the slot that needs completion blocks (teaching-and-learning 09 D).
// - Each published Assessment of the Class, not cancelled, blocks while an attempt is
//   in progress, waits to be marked or waits for release, and while a Student may still
//   answer it: an ONLINE one while a Student placed in the Class now has an attempt left
//   before their hard end - the Class's window, a make-up's, or with acceptLate the
//   Semester's last day (owner, 2026-10-18: late hand-ins after finalising would move a
//   finalised grade, so the Teacher turns acceptLate off or waits) - and an OFFLINE one
//   while a Student has no mark before its window closes. Whether it was ever released
//   is not asked: a release that records no Score - nobody handed in - marks none.
// - An Assessment of an earlier Class that a Student this slot reports still waits on
//   blocks too, so no grade moves after its slot is finalised.
// - A Description is optional (owner, 2026-10-18) and blocks nothing.
// - A LATIHAN blocks nothing (assessment ticket 08, owner 2026-10-18): the grade book
//   leaves it out, so an attempt at one may still be in progress at finalising.

// The statuses that count as they are: a Score, or 0 for "did not submit".
const COUNTED = new Set(['RELEASED', 'DID_NOT_SUBMIT']);

// An attempt not yet what will count.
const WAITING = new Set(['IN_PROGRESS', 'WAITING_FOR_MARKING', 'WAITING_FOR_RELEASE']);

// Whether a Student's standing on an Assessment counts as it is, or waits (ticket 02).
const isCounted = (standing) => COUNTED.has(standing.status);

// Counted, with no attempt of theirs still waiting: a remedial waiting for release
// beside a released Score would still move it.
const isSettled = (standing) =>
    isCounted(standing) && !standing.attempts.some((attempt) => WAITING.has(attempt.status));

// An attempt as usedAttemptsOf reads a Submission - whether it was voided, and whether
// it is a remedial: its view says VOID where the Submission was voided.
const asSubmission = (attempt) => ({ voidedAt: attempt.status === 'VOID', remedial: attempt.remedial });

const studentView = (standing) => ({ studentProfileId: standing.studentProfileId, fullName: standing.fullName });

const assessmentRef = (row) => ({ id: row.id, type: row.type, title: row.title, mode: row.mode });

// ---------------------------------------------------------------------------
// The blockers
// ---------------------------------------------------------------------------

// Until when one Student placed in the Class now may still start an attempt at an
// ONLINE Assessment, on their own terms (ownTermsOf): before their hard end, with an
// attempt left and none in progress. Null where they may not.
function mayStartUntil(book, row, standing) {
    if (!standing.placedNow) return null;
    if (standing.attempts.some((attempt) => attempt.status === 'IN_PROGRESS')) return null;
    const exception = book.exceptionOf(row, standing.studentProfileId);
    const terms = ownTermsOf(row, exception);
    const hardEnd = hardEndIn(row, terms, book.reporting.span.end);
    if (book.now >= hardEnd) return null;
    const used = usedAttemptsOf(exception, standing.attempts.map(asSubmission));
    return used < terms.maxAttempts ? hardEnd : null;
}

// Who may still answer an Assessment, and until when: on an ONLINE one those who may
// start an attempt, on an OFFLINE one those with no mark before its window closes.
function openOf(book, row, standings) {
    const untils =
        row.mode === 'ONLINE'
            ? standings.map((standing) => mayStartUntil(book, row, standing)).filter(Boolean)
            : standings.filter((standing) => standing.status === 'NOT_STARTED').map(() => row.closesAt);
    if (untils.length === 0) return null;
    return { students: untils.length, until: new Date(Math.max(...untils.map((until) => until.getTime()))) };
}

// One Assessment of the Class, as it blocks, or null.
function assessmentBlockerOf(book, row) {
    const standings = book.standings.get(row.id);
    const attempts = standings.flatMap((standing) => standing.attempts);
    const count = (status) => attempts.filter((attempt) => attempt.status === status).length;
    const blocker = {
        kind: 'ASSESSMENT',
        assessment: assessmentRef(row),
        inProgress: count('IN_PROGRESS'),
        waitingForMarking: count('WAITING_FOR_MARKING'),
        waitingForRelease: count('WAITING_FOR_RELEASE'),
        open: openOf(book, row, standings),
    };
    const blocks = blocker.inProgress || blocker.waitingForMarking || blocker.waitingForRelease || blocker.open;
    return blocks ? blocker : null;
}

// The Assessments of earlier Classes that still wait on a Student this slot reports,
// each with whom.
function pooledBlockersOf(book) {
    const { classSubject, roster, reporting } = book;
    const byRow = new Map();
    for (const studentProfileId of roster.studentProfileIds.filter(reporting.isReportedHere)) {
        for (const { row, standing } of book.answerableOf(studentProfileId)) {
            if (row.classSubject.classId === classSubject.classId || isSettled(standing)) continue;
            if (!byRow.has(row.id)) byRow.set(row.id, { row, students: [] });
            byRow.get(row.id).students.push(studentView(standing));
        }
    }
    return [...byRow.values()].map(({ row, students }) => ({
        kind: 'POOLED',
        assessment: assessmentRef(row),
        class: { id: row.classSubject.classId, name: row.classSubject.class.name },
        students,
    }));
}

// Everything that blocks finalising the slot now, in the order a Teacher would clear
// it: the Sessions, then the Class's Assessments by opening, then an earlier Class's,
// each with its words (blockerTextOf). Empty when it may be finalised.
async function blockersOf(book) {
    const { classSubject } = book;
    const sessions = await prisma.session.count({
        where: { status: 'SCHEDULED', needsCompletion: true, ...slotSessionWhere(classSubject) },
    });
    const own = book.rows
        .filter((row) => row.classSubject.classId === classSubject.classId)
        .map((row) => assessmentBlockerOf(book, row))
        .filter(Boolean);
    const blockers = [
        ...(sessions ? [{ kind: 'SESSIONS_NEED_COMPLETION', sessions }] : []),
        ...own,
        ...pooledBlockersOf(book),
    ];
    return blockers.map(withText);
}

// ---------------------------------------------------------------------------
// In words
// ---------------------------------------------------------------------------

const namesOf = (students) => students.map((student) => student.fullName ?? 'a student').join(', ');

const ASSESSMENT_PARTS = [
    ['waitingForMarking', (n) => `${n} waiting to be marked`],
    ['waitingForRelease', (n) => `${n} waiting for release`],
    ['inProgress', (n) => `${n} in progress`],
];

function openText(blocker) {
    const { students, until } = blocker.open;
    return blocker.assessment.mode === 'ONLINE'
        ? `${students} may still start an attempt, until ${until.toISOString()}`
        : `${students} without a mark until ${until.toISOString()}`;
}

// One blocker as its reader is told it: 'UAS "Akhir": 3 waiting to be marked'.
function blockerTextOf(blocker) {
    if (blocker.kind === 'SESSIONS_NEED_COMPLETION') return `${blocker.sessions} Session(s) need completion`;
    if (blocker.kind === 'NO_TEACHER') return 'no teacher answers for it';
    const name = `${blocker.assessment.type} "${blocker.assessment.title}"`;
    if (blocker.kind === 'POOLED') return `${name} in ${blocker.class.name}: waiting for ${namesOf(blocker.students)}`;
    const parts = ASSESSMENT_PARTS.filter(([key]) => blocker[key]).map(([key, text]) => text(blocker[key]));
    if (blocker.open) parts.push(openText(blocker));
    return `${name}: ${parts.join(', ')}`;
}

// A blocker with its words beside it, for a screen to show as it is.
const withText = (blocker) => ({ ...blocker, text: blockerTextOf(blocker) });

// ---------------------------------------------------------------------------
// Finalised
// ---------------------------------------------------------------------------

// Whether the slot is finalised now, by whom and when, or null.
async function finalisedView(classSubject) {
    const finalisation = await liveFinalisationOf(classSubject);
    if (!finalisation) return null;
    const user = await prisma.user.findFirst({
        where: { id: finalisation.finalisedByUserId },
        select: { id: true, fullName: true },
    });
    return {
        at: finalisation.finalisedAt,
        by: { userId: finalisation.finalisedByUserId, fullName: user?.fullName ?? null },
    };
}

export { isCounted, blockersOf, withText, finalisedView };
