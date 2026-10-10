import { prisma } from '../../shared/prisma.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { staffStandingOf } from '../sessions/sessions.service.js';
import { rosterOf } from '../tracking/tracking.service.js';
import { questionContentView } from './assessment.bank.js';
import {
    loadAssessment,
    assertTeacherStanding,
    assertNotCancelled,
    describe,
    assessmentView,
} from './assessment.service.js';
import { answerView, essayFileOf, closeExpiredSubmissions } from './assessment.submission.js';
import {
    markedSubmissionSelect,
    numberOf,
    needsMarking,
    pointsOf,
    marksOf,
    scoresOf,
    currentScoreOf,
    countedScoreOf,
    scoreView,
    recordScore,
    correctReleased,
} from './assessment.score.js';

const log = createLogger('Assessment');

// Marking, release and Scores (assessment ticket 04): the teacher marks what the
// automatic marking cannot, comments, and releases; release records the Scores
// (assessment.score.js), which are append-only from then. An OFFLINE Assessment's
// marks are entered here too. The staff read an Assessment's results and one
// Submission at a time; a Student reads their own through assessment.submission.js.
//
// Owner's decisions (2026-10-04, and the build decisions of 2026-10-09: "setuju"):
// - Only the Answering Teacher marks, releases and corrects. The Homeroom Teacher,
//   the Principal and the Vice Principals read everything here and change nothing
//   (handoff #37): 403. Anyone else, another school included: 404.
// - Marking is a draft until release: an ESSAY's points, a SHORT's automatic mark
//   overridden, a comment per answer and one on the Submission. An MCQ or a TF is
//   marked by its key; a wrong key is fixed on the question (assessment.service.js).
// - An ESSAY left empty counts 0 and waits for nobody (2026-10-09). A Submission is
//   fully marked when every other ESSAY answer has the teacher's points.
// - Release records a Score for every closed Submission not void, fully marked and
//   not yet released. It may be pressed again (answered question 2): what was handed
//   in, marked or entered since waits for the next press, and nothing is recorded
//   twice. An ONLINE one is released only once closesAt has passed (2026-10-09), so
//   no marked answer reaches a classmate still answering; an OFFLINE one has no
//   questions to give away, so its teacher releases when ready.
// - After release a mark changes only with a reason, and the Score it moves gets a
//   new row carrying it; a comment changes freely (2026-10-09), being no Score. A
//   released ESSAY keeps a mark: it is changed, never cleared. Points moved between
//   answers get the row too, though the sum stays (2026-10-10).
// - An OFFLINE mark is a Submission without answers (closedBy TEACHER, 2026-10-09),
//   0-100, for a Student of the Class's roster over the Semester (rosterOf), so one
//   who sat the paper and moved since still gets theirs. One per Student.
// - The results list every Student of that roster, and anyone with a Submission:
//   status, attempts, what waits, and the Score that counts. One with no Submission
//   once the window has closed "did not submit": no Score, which is not 0. Ticket 07
//   adds the integrity counts (06) and the make-up windows (05) to it.
// - Nothing in a cancelled Assessment is marked, released or corrected; its Scores
//   stay.

// An OFFLINE mark's Submission shows no question.
const NO_QUESTIONS = { v: 1, questions: [], options: {} };

const staffSubmissionSelect = {
    ...markedSubmissionSelect,
    assessmentId: true,
    studentProfileId: true,
    attempt: true,
    startedAt: true,
    deadlineAt: true,
    submittedAt: true,
    late: true,
    voidedAt: true,
    voidReason: true,
    comment: true,
    releasedAt: true,
    studentProfile: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
};

// A copy as the staff mark against it: its content and its key.
const copySelect = {
    id: true,
    order: true,
    points: true,
    kind: true,
    mcqScoring: true,
    payload: true,
    answerKey: true,
};

// What was saved, and its marks.
const markingAnswerSelect = {
    assessmentQuestionId: true,
    value: true,
    text: true,
    fileStorageKey: true,
    fileName: true,
    fileMimeType: true,
    fileSize: true,
    savedAt: true,
    autoPoints: true,
    teacherPoints: true,
    comment: true,
    chosenOptions: { select: { optionId: true } },
};

const isClosed = (row) => row.submittedAt !== null && row.voidedAt === null;

const fullNameOf = (row) => row.studentProfile.membership.user.fullName;

const correctionNote = (corrected) => (corrected ? `, ${corrected} score(s) corrected` : '');

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

// Its staff (staffStandingOf). A teacher who may only copy it, once its Semester is
// over, reads none of its Submissions.
async function loadForStaff(auth, id) {
    const row = await loadAssessment(id);
    const standing = await staffStandingOf(auth, row.classSubject);
    if (!standing) throw notFound('Assessment not found');
    return { row, standing };
}

// Its Answering Teacher, on a published Assessment not cancelled.
async function loadForMarking(auth, id) {
    const { row, standing } = await loadForStaff(auth, id);
    assertTeacherStanding(standing, 'Assessment not found');
    assertNotCancelled(row);
    if (!row.publishedAt) throw conflict(`${describe(row)} is a draft; it has nothing to mark`);
    return row;
}

// One of its Submissions, closed first if its deadline has passed. Another
// Assessment's is a 404.
async function loadSubmissionOf(row, submissionId) {
    const where = { id: submissionId, assessmentId: row.id };
    const found = await prisma.submission.findFirst({ where, select: { id: true } });
    if (!found) throw notFound('Submission not found');

    await closeExpiredSubmissions(where);
    return prisma.submission.findFirst({ where, select: staffSubmissionSelect });
}

// What each answer named may take: points only on a SHORT or an ESSAY, at most the
// question's, and a released ESSAY's never cleared; and only an answer that exists -
// an unanswered question counts 0.
function assertMarkable(items, copyById, answerByQuestion, released) {
    const unanswered = items.filter((item) => !answerByQuestion.has(item.questionId)).map((item) => item.questionId);
    if (unanswered.length) {
        throw conflict('A question named was not answered; it counts 0', { questionIds: unanswered });
    }
    for (const item of items.filter((entry) => entry.points !== undefined)) {
        const copy = copyById.get(item.questionId);
        if (copy.kind !== 'SHORT' && copy.kind !== 'ESSAY') {
            throw badRequest(`Question ${copy.order} is ${copy.kind}: its key marks it; fix the key instead`);
        }
        if (item.points !== null && item.points > copy.points) {
            throw badRequest(`Question ${copy.order} is worth ${copy.points} point(s)`);
        }
        if (released && item.points === null && copy.kind === 'ESSAY') {
            throw badRequest(`Question ${copy.order} was released with its mark; give it new points instead`);
        }
    }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// Where one Submission stands, for its staff.
function submissionStatusOf(row, mark) {
    if (row.voidedAt) return 'VOID';
    if (!row.submittedAt) return 'IN_PROGRESS';
    if (row.releasedAt) return 'RELEASED';
    return mark.unmarked ? 'WAITING_FOR_MARKING' : 'WAITING_FOR_RELEASE';
}

// One attempt: its mark as it stands - a draft until release - and its newest Score.
// One in progress, or void, has neither.
const attemptView = (row, mark, score) => ({
    id: row.id,
    attempt: row.attempt,
    status: submissionStatusOf(row, mark),
    submittedAt: row.submittedAt,
    closedBy: row.closedBy,
    late: row.late,
    voidReason: row.voidReason,
    releasedAt: row.releasedAt,
    waitingForMarking: mark?.unmarked ?? 0,
    mark: mark ? { value: mark.value, pointsEarned: mark.pointsEarned, pointsTotal: mark.pointsTotal } : null,
    score: scoreView(score),
});

// Where one Student stands: released when a Score counts, else the furthest their
// attempts got. With none, before the window closes they have not started; after it
// they did not submit - no Score, which is not 0 (spec).
function studentStatusOf(attempts, countedScore, row, now) {
    if (countedScore !== null) return 'RELEASED';
    for (const status of ['WAITING_FOR_MARKING', 'WAITING_FOR_RELEASE', 'IN_PROGRESS']) {
        if (attempts.some((attempt) => attempt.status === status)) return status;
    }
    return now < row.closesAt ? 'NOT_STARTED' : 'DID_NOT_SUBMIT';
}

const markingQuestionView = (copy, answer) => ({
    id: copy.id,
    order: copy.order,
    points: copy.points,
    ...questionContentView(copy),
    answer: answerView(copy.kind, answer),
    autoPoints: numberOf(answer?.autoPoints),
    teacherPoints: numberOf(answer?.teacherPoints),
    earned: pointsOf(answer),
    comment: answer?.comment ?? null,
    needsMarking: needsMarking(copy.kind, answer),
});

// One Submission as its staff mark it: each question it showed, with its key, the
// answer, the automatic and the teacher's points and the comment, in the
// Assessment's order; its mark as it stands; and every Score it was given, oldest
// first, corrections with their reasons.
async function markingViewOf(row, standing, submission) {
    const [copies, answers, scores, marks] = await Promise.all([
        prisma.assessmentQuestion.findMany({
            where: { id: { in: submission.shownOrder.questions } },
            select: copySelect,
            orderBy: { order: 'asc' },
        }),
        prisma.submissionAnswer.findMany({ where: { submissionId: submission.id }, select: markingAnswerSelect }),
        scoresOf(prisma, [submission.id]),
        marksOf(prisma, isClosed(submission) ? [submission] : []),
    ]);
    const history = scores.get(submission.id) ?? [];
    const recorders = await prisma.user.findMany({
        where: { id: { in: [...new Set(history.map((score) => score.recordedByUserId))] } },
        select: { id: true, fullName: true },
    });
    const nameOf = new Map(recorders.map((user) => [user.id, user.fullName]));
    const answerById = new Map(answers.map((answer) => [answer.assessmentQuestionId, answer]));

    return {
        assessment: assessmentView(row, standing),
        submission: {
            ...attemptView(submission, marks.get(submission.id), history.at(-1) ?? null),
            student: { studentProfileId: submission.studentProfileId, fullName: fullNameOf(submission) },
            startedAt: submission.startedAt,
            deadlineAt: submission.deadlineAt,
            voidedAt: submission.voidedAt,
            offlineMark: numberOf(submission.offlineMark),
            comment: submission.comment,
        },
        scores: history.map((score) => ({
            ...scoreView(score),
            recordedBy: { userId: score.recordedByUserId, fullName: nameOf.get(score.recordedByUserId) ?? null },
        })),
        questions: copies.map((copy) => markingQuestionView(copy, answerById.get(copy.id))),
    };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// An Assessment's results for its staff: every Student of the Class's roster over the
// Semester, with placedNow, and anyone else with a Submission - each with their
// status, attempts, what waits, and the Score that counts. What waits, counted, is
// what a release would do now. Never a Student's to read (spec invariant 8).
async function results(auth, id) {
    const { row, standing } = await loadForStaff(auth, id);
    const now = new Date();
    await closeExpiredSubmissions({ assessmentId: row.id }, now);
    const [roster, submissions] = await Promise.all([
        rosterOf(auth, row.classSubject),
        prisma.submission.findMany({
            where: { assessmentId: row.id },
            select: staffSubmissionSelect,
            orderBy: { attempt: 'asc' },
        }),
    ]);
    const closed = submissions.filter(isClosed);
    const [marks, scores] = await Promise.all([
        marksOf(prisma, closed),
        scoresOf(prisma, closed.map((submission) => submission.id)),
    ]);

    const nameOf = new Map(roster.nameOf);
    for (const submission of submissions) nameOf.set(submission.studentProfileId, fullNameOf(submission));
    const studentProfileIds = [
        ...new Set([...roster.studentProfileIds, ...submissions.map((submission) => submission.studentProfileId)]),
    ];
    const students = studentProfileIds.map((studentProfileId) => {
        const own = submissions.filter((submission) => submission.studentProfileId === studentProfileId);
        const attempts = own.map((submission) =>
            attemptView(submission, marks.get(submission.id), currentScoreOf(scores, submission.id))
        );
        const countedScore = countedScoreOf(own, scores);
        return {
            studentProfileId,
            fullName: nameOf.get(studentProfileId) ?? null,
            placedNow: roster.placedNow(studentProfileId),
            status: studentStatusOf(attempts, countedScore, row, now),
            countedScore,
            attempts,
        };
    });

    const attempts = students.flatMap((student) => student.attempts);
    const count = (status) => attempts.filter((attempt) => attempt.status === status).length;
    return {
        assessment: assessmentView(row, standing),
        waiting: {
            marking: count('WAITING_FOR_MARKING'),
            release: count('WAITING_FOR_RELEASE'),
            inProgress: count('IN_PROGRESS'),
        },
        students: students.sort((a, b) => (a.fullName ?? '').localeCompare(b.fullName ?? '')),
    };
}

async function submissionForMarking(auth, id, submissionId) {
    const { row, standing } = await loadForStaff(auth, id);
    return markingViewOf(row, standing, await loadSubmissionOf(row, submissionId));
}

// An ESSAY's file, for the staff marking it or reading it.
async function readEssayFile(auth, id, submissionId, questionId) {
    const { row } = await loadForStaff(auth, id);
    const submission = await loadSubmissionOf(row, submissionId);
    const answer = submission.shownOrder.questions.includes(questionId)
        ? await prisma.submissionAnswer.findFirst({
            where: { submissionId: submission.id, assessmentQuestionId: questionId },
            select: { fileStorageKey: true, fileName: true, fileMimeType: true },
        })
        : null;
    if (!answer?.fileStorageKey) throw notFound('File not found');
    return essayFileOf(answer);
}

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

// The teacher's points and comments on a closed Submission's answers, and their
// comment on the whole. Before release a draft, changed freely; after it a change of
// points needs a reason, and a correction carries it whenever an answer's points
// moved, even if the sum did not (2026-10-10) - a comment alone needs none. The
// Submission is claimed first, so a release or a key fix landing at the same moment
// waits for this, or this for it, and is then seen.
async function mark(auth, id, submissionId, { answers = [], comment, reason }) {
    const row = await loadForMarking(auth, id);
    const submission = await loadSubmissionOf(row, submissionId);
    if (submission.closedBy === 'TEACHER') throw conflict('An offline mark is changed with the offline marks');
    if (submission.voidedAt) {
        throw conflict(`This attempt was voided (${submission.voidReason}); nothing in it is marked`);
    }
    if (!submission.submittedAt) throw conflict('This attempt is still in progress; mark it once it is handed in');
    const shown = new Set(submission.shownOrder.questions);
    const stray = answers.filter((item) => !shown.has(item.questionId)).map((item) => item.questionId);
    if (stray.length) throw badRequest('A question named is not in this submission', { questionIds: stray });

    const questionIds = answers.map((item) => item.questionId);
    const corrected = await prisma.$transaction(async (tx) => {
        const claimed = await tx.submission.updateMany({
            where: { id: submission.id, submittedAt: { not: null }, voidedAt: null },
            data: { updatedAt: new Date() },
        });
        if (claimed.count === 0) throw conflict('This attempt was voided meanwhile');

        const { releasedAt } = await tx.submission.findFirst({
            where: { id: submission.id },
            select: { releasedAt: true },
        });
        const copies = await tx.assessmentQuestion.findMany({
            where: { id: { in: questionIds } },
            select: { id: true, order: true, kind: true, points: true },
        });
        const rows = await tx.submissionAnswer.findMany({
            where: { submissionId: submission.id, assessmentQuestionId: { in: questionIds } },
            select: { id: true, assessmentQuestionId: true, autoPoints: true, teacherPoints: true },
        });
        const answerByQuestion = new Map(rows.map((answer) => [answer.assessmentQuestionId, answer]));
        assertMarkable(answers, new Map(copies.map((copy) => [copy.id, copy])), answerByQuestion, releasedAt !== null);

        const answerOf = (item) => answerByQuestion.get(item.questionId);
        const given = answers.filter((item) => item.points !== undefined);
        const pointsChanged = given.some((item) => item.points !== numberOf(answerOf(item).teacherPoints));
        // What an answer earns moved, not only the teacher's points on it: a SHORT given
        // by hand the 2 it earned already moves nothing (owner, 2026-10-10).
        const pointsMoved = given.some(
            (item) => pointsOf({ ...answerOf(item), teacherPoints: item.points }) !== pointsOf(answerOf(item))
        );
        if (releasedAt && pointsChanged && !reason) {
            throw badRequest('This attempt is released; give a reason, which its corrected score carries');
        }

        for (const item of answers) {
            await tx.submissionAnswer.updateMany({
                where: { id: answerByQuestion.get(item.questionId).id },
                data: {
                    ...(item.points !== undefined ? { teacherPoints: item.points } : {}),
                    ...(item.comment !== undefined ? { comment: item.comment } : {}),
                },
            });
        }
        if (comment !== undefined) await tx.submission.updateMany({ where: { id: submission.id }, data: { comment } });
        return releasedAt && pointsChanged
            ? correctReleased(tx, { id: submission.id }, { reason, userId: auth.userId, pointsMoved })
            : 0;
    });

    log.info(`${describe(row)}: attempt ${submission.attempt} marked${correctionNote(corrected)}`);
    return markingViewOf(row, 'teacher', await loadSubmissionOf(row, submission.id));
}

// One Student's offline mark, in the caller's transaction: their Submission made
// with it, or its draft changed, or once released a correction with the reason.
// Claimed first, so two entries for one Student meet in turn; two creating at once
// meet the unique attempt and one is refused.
async function enterOfflineMark(tx, row, item, { reason, userId }) {
    const where = { assessmentId: row.id, studentProfileId: item.studentProfileId, voidedAt: null };
    const now = new Date();
    const claimed = await tx.submission.updateMany({ where, data: { updatedAt: now } });
    if (claimed.count === 0) {
        await tx.submission.create({
            data: {
                assessmentId: row.id,
                studentProfileId: item.studentProfileId,
                attempt: 1,
                startedAt: now,
                deadlineAt: now,
                submittedAt: now,
                closedBy: 'TEACHER',
                shownOrder: NO_QUESTIONS,
                offlineMark: item.value,
                comment: item.comment ?? null,
            },
            select: { id: true },
        });
        return 0;
    }

    const existing = await tx.submission.findFirst({
        where,
        select: { id: true, offlineMark: true, releasedAt: true },
    });
    const changed = item.value !== numberOf(existing.offlineMark);
    if (existing.releasedAt && changed && !reason) {
        throw badRequest('A released mark changes only with a reason, which its corrected score carries', {
            studentProfileId: item.studentProfileId,
        });
    }
    await tx.submission.updateMany({
        where: { id: existing.id },
        data: { offlineMark: item.value, ...(item.comment !== undefined ? { comment: item.comment } : {}) },
    });
    return existing.releasedAt && changed ? correctReleased(tx, { id: existing.id }, { reason, userId }) : 0;
}

// An OFFLINE Assessment's marks, 0-100, for Students of the Class's roster over the
// Semester. All of them, or none. Answers with the results.
async function enterOfflineMarks(auth, id, { marks, reason }) {
    const row = await loadForMarking(auth, id);
    if (row.mode !== 'OFFLINE') throw conflict(`${describe(row)} is online; its attempts are marked answer by answer`);
    const roster = await rosterOf(auth, row.classSubject);
    const onRoster = new Set(roster.studentProfileIds);
    const stray = marks.filter((item) => !onRoster.has(item.studentProfileId)).map((item) => item.studentProfileId);
    if (stray.length) {
        throw badRequest(`Enter marks only for students of ${row.classSubject.class.name} in this Semester`, {
            studentProfileIds: stray,
        });
    }

    let corrected;
    try {
        corrected = await prisma.$transaction(async (tx) => {
            let count = 0;
            for (const item of marks) count += await enterOfflineMark(tx, row, item, { reason, userId: auth.userId });
            return count;
        });
    } catch (error) {
        if (error?.code !== 'P2002') throw error;
        throw conflict('Marks were entered meanwhile; reload them and try again');
    }

    log.info(`${describe(row)}: ${marks.length} offline mark(s) saved${correctionNote(corrected)}`);
    return results(auth, row.id);
}

// ---------------------------------------------------------------------------
// Releasing
// ---------------------------------------------------------------------------

// Records a Score for every closed Submission not void, fully marked and not yet
// released, and says what still waits. The Assessment is claimed first, so a second
// press, or a key fix, at the same moment waits for this one; then the Submissions
// it may release, so marking at the same moment lands before or after, never half.
async function release(auth, id) {
    const row = await loadForMarking(auth, id);
    const now = new Date();
    if (row.mode === 'ONLINE' && now < row.closesAt) {
        throw conflict(`${describe(row)} is open until ${row.closesAt.toISOString()}; release it once it has closed`);
    }
    await closeExpiredSubmissions({ assessmentId: row.id }, now);

    const outcome = await prisma.$transaction(async (tx) => {
        const claimed = await tx.assessment.updateMany({
            where: { id: row.id, deletedAt: null, cancelledAt: null },
            data: { updatedAt: now },
        });
        if (claimed.count === 0) throw conflict(`${describe(row)} was cancelled meanwhile`);

        const pendingWhere = { assessmentId: row.id, voidedAt: null, releasedAt: null };
        await tx.submission.updateMany({
            where: { ...pendingWhere, submittedAt: { not: null } },
            data: { updatedAt: now },
        });
        const pending = await tx.submission.findMany({
            where: pendingWhere,
            select: { ...markedSubmissionSelect, submittedAt: true },
        });
        const closed = pending.filter((submission) => submission.submittedAt);
        const marks = await marksOf(tx, closed);
        const ready = closed.filter((submission) => marks.get(submission.id).unmarked === 0);
        let released = 0;
        for (const submission of ready) {
            const taken = await tx.submission.updateMany({
                where: { id: submission.id, releasedAt: null },
                data: { releasedAt: now },
            });
            if (taken.count === 0) continue;
            await recordScore(tx, submission.id, marks.get(submission.id), { userId: auth.userId });
            released += 1;
        }
        if (released) {
            await tx.assessment.updateMany({ where: { id: row.id, releasedAt: null }, data: { releasedAt: now } });
        }
        // Ticket 06 writes assessment.released here, naming how many Scores it recorded.
        return {
            released,
            waitingForMarking: closed.length - ready.length,
            inProgress: pending.length - closed.length,
        };
    });

    log.info(
        `${describe(row)} released: ${outcome.released} score(s) recorded, ` +
            `${outcome.waitingForMarking} waiting for marking, ${outcome.inProgress} in progress`
    );
    return { assessment: assessmentView(await loadAssessment(row.id), 'teacher'), ...outcome };
}

export { results, submissionForMarking, readEssayFile, mark, enterOfflineMarks, release };
