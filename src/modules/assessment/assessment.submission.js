import crypto from 'node:crypto';

import { prisma } from '../../shared/prisma.js';
import { currentPlacement } from '../../shared/guards.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { getStorage } from '../../shared/storage.js';
import { MIME } from '../../shared/upload.js';
import { createLogger } from '../../lib/helpers.js';
import { semesterSpan } from '../sessions/sessions.service.js';
import { INLINE_TYPES, fileNameOf, studentProfileOf } from '../content/content.service.js';
import { imageIdsOf, imageFileOf } from './assessment.bank.js';
import { autoPointsOf } from './assessment.grading.js';
import { scoresOf, currentScoreOf, countedScoreOf, scoreView, pointsOf } from './assessment.score.js';

const log = createLogger('Assessment');

// Answering (assessment ticket 03): a Student's Submissions to an ONLINE Assessment
// of the Class they sit in now - started, answered question by question, handed in
// or closed by time, and marked automatically as a draft that ticket 04 releases.
// assessment.service.js calls the voiding and re-marking here when a published
// Assessment changes under its Submissions.
//
// Owner's decisions (2026-10-04, and the build decisions of 2026-10-08):
// - Who answers: a Student placed in the Class now (currentPlacement). One who moves
//   in sees what is still open; one who moves out keeps their Submissions, reads
//   them, and starts or answers nothing more.
// - When: from opensAt to closesAt. With acceptLate, starting and handing in stay
//   open until the end of the Semester's last day, flagged late (answered question 3).
// - Max attempts count the Submissions not void.
// - The time limit runs from the start, capped by that hard end. Answers are saved
//   one by one, so a lost connection loses nothing. A Submission whose deadline has
//   passed is closed the first time anything touches it, as of its deadline, and
//   what was saved is marked: no job watches the clock (2026-10-08).
// - The questions reach a Student only inside a Submission: before starting they see
//   the Assessment's outline, never a question (2026-10-08).
// - The order shown - the questions and each MCQ's options, shuffled each on its own
//   when the Assessment says so - is drawn once at the start and kept (2026-10-08).
// - An ESSAY's answer is plain text, at most 20,000 characters, a file, or both
//   (2026-10-08); the file follows Content's rules, macros refused.
// - A correct answer never reaches a Student before release (spec invariant 3): no
//   key, no accepted answer and no points earned leave here. Every read of an
//   Assessment for a Student is studentAssessmentSelect, and the copies are read
//   without their key.
// - Saving an answer writes no Learning Event (answered question 4). Starting and
//   handing in will, from ticket 06.
// - Once its Submission is released (ticket 04) the Student reads its Score - the
//   newest, with the newest correction's reason - the points each answer earned and
//   the comments, and the key only if the teacher chose to show it. Before that,
//   none of them; and nothing of anyone else's, ever (spec invariant 8).

const SHAPE_VERSION = 1;
const MINUTE_MS = 60 * 1000;
const MAX_SHORT_LENGTH = 200;
// The integrity signals are recorded on these only (spec; ticket 06 records them).
const SIGNALLED_TYPES = new Set(['KUIS', 'UTS', 'UAS']);
const TYPE_OF_MIME = Object.fromEntries(Object.entries(MIME).map(([type, mime]) => [mime, type]));

const LIVE = { removedAt: null };
const IN_PROGRESS = { submittedAt: null, voidedAt: null };

// What a Student's routes read of an Assessment, and the only read of one they make:
// a select with no answer key anywhere. The global omit in src/shared/prisma.js sits
// under it.
const studentAssessmentSelect = {
    id: true,
    type: true,
    mode: true,
    title: true,
    instructions: true,
    opensAt: true,
    closesAt: true,
    maxAttempts: true,
    acceptLate: true,
    timeLimitMinutes: true,
    shuffleQuestions: true,
    shuffleOptions: true,
    showKeyOnRelease: true,
    cancelledAt: true,
    cancelReason: true,
    classSubject: {
        select: {
            id: true,
            classId: true,
            class: { select: { id: true, name: true, gradeLevel: true, academicYear: { select: { label: true } } } },
            subject: { select: { id: true, code: true, name: true } },
            semester: { select: { id: true, ordinal: true, startDate: true, endDate: true } },
        },
    },
    questions: { where: LIVE, select: { id: true, points: true }, orderBy: { order: 'asc' } },
};

// A copy as a Student sees it. payload holds the body, the image and the options,
// none of them marked correct: the key is a column of its own.
const studentQuestionSelect = { id: true, kind: true, mcqScoring: true, points: true, payload: true };

const submissionSelect = {
    id: true,
    assessmentId: true,
    attempt: true,
    startedAt: true,
    deadlineAt: true,
    submittedAt: true,
    closedBy: true,
    late: true,
    voidedAt: true,
    voidReason: true,
    shownOrder: true,
    comment: true,
    releasedAt: true,
};

// A saved answer, without its points: they stay with the staff until release.
const answerSelect = {
    assessmentQuestionId: true,
    value: true,
    text: true,
    fileName: true,
    fileMimeType: true,
    fileSize: true,
    savedAt: true,
    chosenOptions: { select: { optionId: true } },
};

// The same, with its marks, read for a Student only once their Submission is
// released (ticket 04).
const releasedAnswerSelect = { ...answerSelect, autoPoints: true, teacherPoints: true, comment: true };

// What marking reads: the answer, and its copy with the key.
const markingSelect = {
    id: true,
    value: true,
    text: true,
    chosenOptions: { select: { optionId: true } },
    assessmentQuestion: { select: { kind: true, mcqScoring: true, points: true, answerKey: true } },
};

// 'KUIS "Bab 3" of MTK in 11A', for messages and log lines.
const describe = (row) =>
    `${row.type} "${row.title}" of ${row.classSubject.subject.code} in ${row.classSubject.class.name}`;

const isInProgress = (row) => row.submittedAt === null && row.voidedAt === null;

// ---------------------------------------------------------------------------
// Marking
// ---------------------------------------------------------------------------

// Each answer's automatic points (assessment.grading.js), the key read here on the
// server only. An unanswered question has no row and earns nothing; an ESSAY's stays
// null for the teacher.
async function markAnswers(tx, where) {
    const answers = await tx.submissionAnswer.findMany({ where, select: markingSelect });
    for (const answer of answers) {
        const autoPoints = autoPointsOf(answer.assessmentQuestion, {
            optionIds: answer.chosenOptions.map((chosen) => chosen.optionId),
            value: answer.value,
            text: answer.text,
        });
        await tx.submissionAnswer.updateMany({ where: { id: answer.id }, data: { autoPoints } });
    }
    return answers.length;
}

const markSubmission = (tx, submissionId) => markAnswers(tx, { submissionId });

// The answers to these copies marked again, after a key or points changed (spec,
// "Changes after publishing"), in every closed Submission not void. One in progress
// is marked when it closes. Runs in the caller's transaction.
const remarkQuestions = (tx, assessmentQuestionIds) =>
    markAnswers(tx, {
        assessmentQuestionId: { in: assessmentQuestionIds },
        submission: { submittedAt: { not: null }, voidedAt: null },
    });

// Every Submission not void, in progress or handed in: a question changed under
// them. Kept, never deleted, and no longer counted toward max attempts, so their
// Students may answer again. Runs in the caller's transaction.
async function voidSubmissions(tx, assessmentId, reason, now) {
    const voided = await tx.submission.updateMany({
        where: { assessmentId, voidedAt: null },
        data: { voidedAt: now, voidReason: reason },
    });
    return voided.count;
}

// How many Submissions not void an Assessment has: what voiding would reach.
const liveSubmissionCountOf = (assessmentId) => prisma.submission.count({ where: { assessmentId, voidedAt: null } });

const submissionCountOf = (assessmentId) => prisma.submission.count({ where: { assessmentId } });

// ---------------------------------------------------------------------------
// Closing by time
// ---------------------------------------------------------------------------

// The Submissions among `where` whose deadline has passed, closed as of that
// deadline, and marked (owner, 2026-10-08). Whoever touches one first - its Student,
// the staff's results or marking, a release (ticket 04) - closes it, and gets what a
// clock would have written. Each is claimed, so two readers at once close it once.
async function closeExpiredSubmissions(where, now = new Date()) {
    const expired = await prisma.submission.findMany({
        where: { ...where, ...IN_PROGRESS, deadlineAt: { lte: now } },
        select: { id: true, attempt: true, deadlineAt: true, assessment: { select: studentAssessmentSelect } },
    });
    for (const row of expired) {
        const closed = await prisma.$transaction(async (tx) => {
            const claimed = await tx.submission.updateMany({
                where: { id: row.id, ...IN_PROGRESS },
                data: { submittedAt: row.deadlineAt, closedBy: 'TIME', late: row.deadlineAt > row.assessment.closesAt },
            });
            if (claimed.count === 0) return false;
            await markSubmission(tx, row.id);
            // Ticket 06 writes assessment.submitted here, closed by time.
            return true;
        });
        if (closed) log.info(`${describe(row.assessment)}: attempt ${row.attempt} closed at its deadline`);
    }
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

// A published Assessment, not deleted. A draft does not exist for a Student.
async function loadPublished(id) {
    const row = await prisma.assessment.findFirst({
        where: { id, deletedAt: null, publishedAt: { not: null } },
        select: studentAssessmentSelect,
    });
    if (!row) throw notFound('Assessment not found');
    return row;
}

// An Assessment of the Class the Student sits in now. Another Class's, another
// school's, or a draft: the 404 of one that does not exist.
async function loadForStudent(auth, id) {
    const [row, placement] = await Promise.all([loadPublished(id), currentPlacement(auth.membershipId)]);
    if (placement?.classId !== row.classSubject.classId) throw notFound('Assessment not found');
    return { row, studentProfileId: placement.studentProfileId };
}

// The caller's own Submission, on their live profile, closed first if its deadline
// has passed. Anyone else's is a 404. Read even after a class move: it is theirs.
async function loadOwnSubmission(auth, id) {
    const studentProfileId = await studentProfileOf(auth);
    if (!studentProfileId) throw notFound('Submission not found');
    const where = { id, studentProfileId };
    const found = await prisma.submission.findFirst({ where, select: { id: true } });
    if (!found) throw notFound('Submission not found');

    await closeExpiredSubmissions(where);
    return prisma.submission.findFirst({ where, select: submissionSelect });
}

// A Submission the caller may still answer in: their own, in progress, of an
// Assessment not cancelled, in the Class they sit in now. One past its deadline was
// just closed, and is refused (ticket: "a save after it is refused, and the
// Submission is closed"). With a questionId, one of the questions it shows.
async function loadAnswerable(auth, submissionId, questionId = null) {
    const submission = await loadOwnSubmission(auth, submissionId);
    if (submission.voidedAt) {
        throw conflict(`This attempt was voided (${submission.voidReason}); start a new one`);
    }
    if (submission.submittedAt) {
        throw conflict(
            submission.closedBy === 'TIME'
                ? 'Time is up: this attempt was closed with the answers you saved'
                : 'This attempt is handed in already'
        );
    }
    const [assessment, placement] = await Promise.all([
        loadPublished(submission.assessmentId),
        currentPlacement(auth.membershipId),
    ]);
    if (assessment.cancelledAt) throw conflict(`${describe(assessment)} was cancelled`);
    if (placement?.classId !== assessment.classSubject.classId) {
        const className = assessment.classSubject.class.name;
        throw conflict(`You are no longer in ${className}; this attempt takes no more answers`);
    }
    if (questionId === null) return { submission, assessment };

    if (!submission.shownOrder.questions.includes(questionId)) throw notFound('Question not found');
    const question = await prisma.assessmentQuestion.findFirst({
        where: { id: questionId },
        select: studentQuestionSelect,
    });
    return { submission, assessment, question };
}

// The Submission still open to answers, claimed for this transaction: a hand-in or
// a close landing at the same moment waits for it, or it finds that one done.
async function claimOpen(tx, submissionId, now) {
    const claimed = await tx.submission.updateMany({
        where: { id: submissionId, ...IN_PROGRESS, deadlineAt: { gt: now } },
        data: { updatedAt: now },
    });
    if (claimed.count === 0) throw conflict('This attempt was closed meanwhile');
}

// The hard end no Submission passes: closesAt, or with acceptLate the end of the
// Semester's last day in the school's zone (answered question 3).
async function hardEndOf(auth, assessment) {
    if (!assessment.acceptLate) return assessment.closesAt;
    return (await semesterSpan(auth.schoolId, assessment.classSubject.semester)).end;
}

// Why the Student may not start an attempt now, as the error start() throws, or null:
// one rule for start() and the outline's canStart. Lowering maxAttempts below what a
// Student used keeps what they did, and they start no new one (answered question 6).
function startRefusalOf(row, { used, inProgress, now, hardEnd }) {
    if (row.mode === 'OFFLINE') return badRequest(`${describe(row)} is offline: the teacher enters its marks`);
    if (row.cancelledAt) return conflict(`${describe(row)} was cancelled`);
    if (row.questions.length === 0) return conflict(`${describe(row)} has no questions`);
    if (inProgress) return conflict('You have an attempt in progress; continue it');
    if (now < row.opensAt) return conflict(`${describe(row)} is not open yet`);
    if (now >= hardEnd) return conflict(`${describe(row)} is closed`);
    if (used >= row.maxAttempts) return conflict(`You have used every attempt at ${describe(row)}`);
    return null;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const statusOf = (row) => {
    if (row.voidedAt) return 'VOID';
    return row.submittedAt ? 'SUBMITTED' : 'IN_PROGRESS';
};

// A Student's own Submission. Its Score and the teacher's comment only once it is
// released (ticket 04): `score` is the newest Score row.
const ownSubmissionView = (row, score = null) => ({
    id: row.id,
    attempt: row.attempt,
    status: statusOf(row),
    startedAt: row.startedAt,
    deadlineAt: row.deadlineAt,
    submittedAt: row.submittedAt,
    closedBy: row.closedBy,
    late: row.late,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    released: row.releasedAt !== null,
    score: row.releasedAt ? scoreView(score) : null,
    comment: row.releasedAt ? row.comment : null,
});

// The outline a Student reads: never a question.
const studentAssessmentView = (row) => ({
    id: row.id,
    classSubject: {
        id: row.classSubject.id,
        class: {
            id: row.classSubject.class.id,
            name: row.classSubject.class.name,
            gradeLevel: row.classSubject.class.gradeLevel,
            academicYear: row.classSubject.class.academicYear.label,
        },
        subject: row.classSubject.subject,
    },
    type: row.type,
    mode: row.mode,
    title: row.title,
    instructions: row.instructions,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    acceptLate: row.acceptLate,
    timeLimitMinutes: row.timeLimitMinutes,
    maxAttempts: row.maxAttempts,
    status: row.cancelledAt ? 'CANCELLED' : 'PUBLISHED',
    cancelReason: row.cancelReason,
    questionCount: row.questions.length,
    totalPoints: row.questions.reduce((sum, question) => sum + question.points, 0),
    // The Student is told before starting that these are recorded (spec).
    integritySignals: row.mode === 'ONLINE' && SIGNALLED_TYPES.has(row.type),
});

// What each kind's answer holds: the one field a body sends, its rule, the columns
// it writes, and how a saved one reads back. An ESSAY's file has its own route.
const ANSWERS = {
    MCQ: {
        field: 'optionIds',
        check: (question, optionIds) => {
            const known = new Set(question.payload.options.map((option) => option.id));
            const stray = (optionIds ?? []).filter((optionId) => !known.has(optionId));
            if (stray.length) {
                throw badRequest('An option chosen does not belong to this question', { optionIds: stray });
            }
            if (question.mcqScoring === 'SINGLE' && optionIds?.length > 1) {
                throw badRequest('Choose one option for this question');
            }
        },
        data: () => ({}),
        view: (row) => ({ optionIds: row.chosenOptions.map((chosen) => chosen.optionId) }),
    },
    TF: {
        field: 'value',
        check: () => {},
        data: (value) => ({ value }),
        view: (row) => ({ value: row.value }),
    },
    SHORT: {
        field: 'text',
        check: (_question, text) => {
            if (text?.length > MAX_SHORT_LENGTH) {
                throw badRequest(`A short answer is at most ${MAX_SHORT_LENGTH} characters`);
            }
        },
        data: (text) => ({ text }),
        view: (row) => ({ text: row.text }),
    },
    ESSAY: {
        field: 'text',
        check: () => {},
        data: (text) => ({ text }),
        view: (row) => ({
            text: row.text,
            file: row.fileName ? { name: row.fileName, mimeType: row.fileMimeType, size: row.fileSize } : null,
        }),
    },
};

const answerView = (kind, row) => (row ? { ...ANSWERS[kind].view(row), savedAt: row.savedAt } : null);

// A copy's key as a released Student may be shown it: the copy's own, without its
// shape version; an ESSAY has none.
const keyView = (question) => {
    if (!question.answerKey) return null;
    const { v: _version, ...key } = question.answerKey;
    return key;
};

// A question as this Submission shows it: its options in the order drawn, none
// marked, and the Student's own saved answer. Released (ticket 04): the points it
// earned and the teacher's comment, and with showKeyOnRelease its key.
function studentQuestionView(question, optionOrder, answer, { released = false, showKey = false } = {}) {
    const { body, imageId, options } = question.payload;
    const byId = new Map((options ?? []).map((option) => [option.id, option]));
    return {
        id: question.id,
        kind: question.kind,
        mcqScoring: question.mcqScoring,
        points: question.points,
        body,
        imageId,
        ...(question.kind === 'MCQ'
            ? { options: (optionOrder ?? []).map((optionId) => byId.get(optionId)).filter(Boolean) }
            : {}),
        answer: answerView(question.kind, answer),
        marks: released ? { points: pointsOf(answer), comment: answer?.comment ?? null } : null,
        key: released && showKey ? keyView(question) : null,
    };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Before starting: the outline, what the Student may still do, and their own
// Submissions to it. No question (2026-10-08).
async function outlineForStudent(auth, id) {
    const { row, studentProfileId } = await loadForStudent(auth, id);
    const now = new Date();
    await closeExpiredSubmissions({ assessmentId: row.id, studentProfileId }, now);
    const [submissions, hardEnd] = await Promise.all([
        prisma.submission.findMany({
            where: { assessmentId: row.id, studentProfileId },
            select: submissionSelect,
            orderBy: { attempt: 'asc' },
        }),
        hardEndOf(auth, row),
    ]);

    const used = submissions.filter((submission) => !submission.voidedAt).length;
    const inProgress = submissions.find(isInProgress) ?? null;
    const scores = await scoresOf(
        prisma,
        submissions.filter((submission) => submission.releasedAt).map((submission) => submission.id)
    );
    return {
        assessment: studentAssessmentView(row),
        attemptsUsed: used,
        // An OFFLINE one takes no attempt: the teacher enters its marks.
        attemptsLeft: row.mode === 'ONLINE' ? Math.max(0, row.maxAttempts - used) : 0,
        inProgressId: inProgress?.id ?? null,
        canStart: startRefusalOf(row, { used, inProgress, now, hardEnd }) === null,
        // The Score that counts: the highest of the released ones (ticket 04), else null.
        score: countedScoreOf(submissions, scores),
        submissions: submissions.map((submission) =>
            ownSubmissionView(submission, currentScoreOf(scores, submission.id))
        ),
    };
}

// One of the Student's own Submissions with its questions as shown, and what they
// saved. Before release never a key and never points earned; a closed or void one
// reads the same. Released (ticket 04): its Score, each answer's points and comment,
// and the key when the teacher shows it - read with it only then.
async function submissionForStudent(auth, id) {
    const submission = await loadOwnSubmission(auth, id);
    const released = submission.releasedAt !== null;
    const assessment = await loadPublished(submission.assessmentId);
    const showKey = released && assessment.showKeyOnRelease;
    const questionIds = submission.shownOrder.questions;
    const [questions, answers, scores] = await Promise.all([
        prisma.assessmentQuestion.findMany({
            where: { id: { in: questionIds } },
            select: showKey ? { ...studentQuestionSelect, answerKey: true } : studentQuestionSelect,
        }),
        prisma.submissionAnswer.findMany({
            where: { submissionId: submission.id },
            select: released ? releasedAnswerSelect : answerSelect,
        }),
        scoresOf(prisma, released ? [submission.id] : []),
    ]);

    const questionById = new Map(questions.map((question) => [question.id, question]));
    const answerById = new Map(answers.map((answer) => [answer.assessmentQuestionId, answer]));
    return {
        submission: ownSubmissionView(submission, currentScoreOf(scores, submission.id)),
        assessment: studentAssessmentView(assessment),
        questions: questionIds.map((questionId) =>
            studentQuestionView(
                questionById.get(questionId),
                submission.shownOrder.options[questionId],
                answerById.get(questionId),
                { released, showKey }
            )
        ),
    };
}

// An ESSAY's file, as a route sends it: PDF and images open in the browser, DOCX and
// PPTX download. For its Student here, and for the staff (ticket 04).
const essayFileOf = async (answer) => ({
    buffer: await getStorage().read(answer.fileStorageKey),
    contentType: answer.fileMimeType,
    fileName: answer.fileName,
    inline: INLINE_TYPES.has(TYPE_OF_MIME[answer.fileMimeType]),
});

// An ESSAY's file, back to the Student who sent it.
async function readEssayFile(auth, submissionId, questionId) {
    const submission = await loadOwnSubmission(auth, submissionId);
    const answer = submission.shownOrder.questions.includes(questionId)
        ? await prisma.submissionAnswer.findFirst({
            where: { submissionId: submission.id, assessmentQuestionId: questionId },
            select: { fileStorageKey: true, fileName: true, fileMimeType: true },
        })
        : null;
    if (!answer?.fileStorageKey) throw notFound('File not found');
    return essayFileOf(answer);
}

// An image one of its questions holds, for the Student answering it. One no question
// of theirs holds is a 404, so an id alone opens nothing.
async function readImage(auth, submissionId, imageId) {
    const submission = await loadOwnSubmission(auth, submissionId);
    const questions = await prisma.assessmentQuestion.findMany({
        where: { id: { in: submission.shownOrder.questions } },
        select: { payload: true },
    });
    if (!questions.some((question) => imageIdsOf(question.payload).includes(imageId))) {
        throw notFound('Image not found');
    }

    const image = await prisma.questionImage.findFirst({ where: { id: imageId } });
    if (!image) throw notFound('Image not found');
    return imageFileOf(image);
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

// Fisher-Yates, with crypto's randomness.
function shuffled(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// What the Student is shown, drawn once (2026-10-08): the questions in the
// Assessment's order or shuffled, and each MCQ's options likewise, each on its own.
function shownOrderOf(row, questions) {
    const options = Object.fromEntries(
        questions
            .filter((question) => question.kind === 'MCQ')
            .map((question) => {
                const optionIds = question.payload.options.map((option) => option.id);
                return [question.id, row.shuffleOptions ? shuffled(optionIds) : optionIds];
            })
    );
    const questionIds = questions.map((question) => question.id);
    return { v: SHAPE_VERSION, questions: row.shuffleQuestions ? shuffled(questionIds) : questionIds, options };
}

// A new attempt. A second one in progress is impossible, even racing: the partial
// unique index Submission_one_in_progress_per_student, and the attempt number's.
async function start(auth, id) {
    const { row, studentProfileId } = await loadForStudent(auth, id);
    const now = new Date();
    await closeExpiredSubmissions({ assessmentId: row.id, studentProfileId }, now);
    const [submissions, hardEnd] = await Promise.all([
        prisma.submission.findMany({
            where: { assessmentId: row.id, studentProfileId },
            select: { submittedAt: true, voidedAt: true },
        }),
        hardEndOf(auth, row),
    ]);
    const used = submissions.filter((submission) => !submission.voidedAt).length;
    const refusal = startRefusalOf(row, { used, inProgress: submissions.some(isInProgress), now, hardEnd });
    if (refusal) throw refusal;

    const limit = row.timeLimitMinutes ? new Date(now.getTime() + row.timeLimitMinutes * MINUTE_MS) : hardEnd;
    const questions = await prisma.assessmentQuestion.findMany({
        where: { assessmentId: row.id, ...LIVE },
        select: { id: true, kind: true, payload: true },
        orderBy: { order: 'asc' },
    });
    const attempt = submissions.length + 1;

    let created;
    try {
        created = await prisma.$transaction(async (tx) => {
            const submission = await tx.submission.create({
                data: {
                    assessmentId: row.id,
                    studentProfileId,
                    attempt,
                    startedAt: now,
                    deadlineAt: limit < hardEnd ? limit : hardEnd,
                    shownOrder: shownOrderOf(row, questions),
                },
                select: { id: true },
            });
            // Ticket 06 writes assessment.submission_started here.
            return submission;
        });
    } catch (error) {
        if (error?.code !== 'P2002') throw error;
        throw conflict('An attempt was started meanwhile; continue it');
    }

    log.info(`${describe(row)}: attempt ${attempt} started`);
    return submissionForStudent(auth, created.id);
}

// The answer row for a question, created or changed. Written after claimOpen, which
// holds the Submission, so two saves of one question meet in turn, never both
// creating.
async function writeAnswer(tx, submissionId, assessmentQuestionId, data) {
    const existing = await tx.submissionAnswer.findFirst({
        where: { submissionId, assessmentQuestionId },
        select: { id: true },
    });
    if (existing) {
        await tx.submissionAnswer.updateMany({ where: { id: existing.id }, data });
        return existing.id;
    }
    const created = await tx.submissionAnswer.create({
        data: { submissionId, assessmentQuestionId, ...data },
        select: { id: true },
    });
    return created.id;
}

const readAnswer = (submissionId, assessmentQuestionId) =>
    prisma.submissionAnswer.findFirst({ where: { submissionId, assessmentQuestionId }, select: answerSelect });

// One question's answer, saved as the Student goes: optionIds for an MCQ, value for a
// TF, text for a SHORT or an ESSAY. null or [] clears it. No Learning Event (answered
// question 4), and no mark until the Submission closes.
async function saveAnswer(auth, submissionId, questionId, body) {
    const { submission, assessment, question } = await loadAnswerable(auth, submissionId, questionId);
    const kind = ANSWERS[question.kind];
    const sent = Object.keys(body);
    if (sent.length !== 1 || sent[0] !== kind.field) {
        throw badRequest(`Answer this ${question.kind} question with ${kind.field}`);
    }
    const value = body[kind.field];
    kind.check(question, value);

    const now = new Date();
    await prisma.$transaction(async (tx) => {
        await claimOpen(tx, submission.id, now);
        const answerId = await writeAnswer(tx, submission.id, question.id, { ...kind.data(value), savedAt: now });
        if (question.kind !== 'MCQ') return;

        await tx.submissionAnswerOption.deleteMany({ where: { answerId } });
        if (value?.length) {
            await tx.submissionAnswerOption.createMany({
                data: value.map((optionId) => ({ answerId, assessmentQuestionId: question.id, optionId })),
            });
        }
    });

    log.info(`${describe(assessment)}: a ${question.kind} answer saved to attempt ${submission.attempt}`);
    return answerView(question.kind, await readAnswer(submission.id, question.id));
}

// An ESSAY's file, typed from its bytes by singleFile: PDF, JPG, PNG, DOCX or PPTX,
// at most 10 MB, macros refused - Content's rules. A second one takes the first's
// place in the answer; the first stays in storage, as Content's files do. A failure
// after the file is written removes it again.
async function saveEssayFile(auth, submissionId, questionId, file) {
    const { submission, assessment, question } = await loadAnswerable(auth, submissionId, questionId);
    if (question.kind !== 'ESSAY') throw badRequest('Only an ESSAY answer takes a file');

    const type = file.detectedType;
    const storage = getStorage();
    const storageKey = await storage.save(file.buffer, {
        folder: `submissions/${auth.schoolId}`,
        originalName: `answer.${type}`,
    });
    const now = new Date();
    try {
        await prisma.$transaction(async (tx) => {
            await claimOpen(tx, submission.id, now);
            await writeAnswer(tx, submission.id, question.id, {
                fileStorageKey: storageKey,
                fileName: fileNameOf(file.originalname, type),
                fileMimeType: MIME[type],
                fileSize: file.size,
                savedAt: now,
            });
        });
    } catch (error) {
        await storage.remove(storageKey);
        throw error;
    }

    log.info(`${describe(assessment)}: an essay file (${type.toUpperCase()}) saved to attempt ${submission.attempt}`);
    return answerView(question.kind, await readAnswer(submission.id, question.id));
}

// The Student hands it in, before its deadline: marked in the same transaction, and
// late after closesAt, which only acceptLate allows. Past the deadline it was closed
// by time already, and this is refused.
async function handIn(auth, submissionId) {
    const { submission, assessment } = await loadAnswerable(auth, submissionId);
    const now = new Date();
    const late = now > assessment.closesAt;
    await prisma.$transaction(async (tx) => {
        const claimed = await tx.submission.updateMany({
            where: { id: submission.id, ...IN_PROGRESS, deadlineAt: { gt: now } },
            data: { submittedAt: now, closedBy: 'STUDENT', late },
        });
        if (claimed.count === 0) throw conflict('This attempt was closed meanwhile');
        await markSubmission(tx, submission.id);
        // Ticket 06 writes assessment.submitted here, with late.
    });

    log.info(`${describe(assessment)}: attempt ${submission.attempt} handed in${late ? ', late' : ''}`);
    return submissionForStudent(auth, submission.id);
}

export {
    answerView,
    essayFileOf,
    closeExpiredSubmissions,
    voidSubmissions,
    remarkQuestions,
    liveSubmissionCountOf,
    submissionCountOf,
    outlineForStudent,
    submissionForStudent,
    readEssayFile,
    readImage,
    start,
    saveAnswer,
    saveEssayFile,
    handIn,
};
