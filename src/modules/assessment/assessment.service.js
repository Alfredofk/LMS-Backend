import { Prisma } from '@prisma/client';

import { prisma } from '../../shared/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { staffStandingOf, semesterSpan, todayOf } from '../sessions/sessions.service.js';
import { slotSessionWhere } from '../tracking/tracking.service.js';
import { cleanText } from '../content/content.service.js';
import { toDate, toDay } from '../holidays/holidays.calendar.js';
import {
    imageIdsOf,
    imageFileOf,
    payloadAndKeyOf,
    questionContentView,
    pickableQuestionsOf,
    taughtNowOf,
    privateFromWhere,
} from './assessment.bank.js';
import {
    voidSubmissions,
    remarkQuestions,
    liveSubmissionCountOf,
    submissionCountOf,
} from './assessment.submission.js';

const log = createLogger('Assessment');

// Assessments (assessment ticket 02): one graded exercise on a ClassSubject - its
// type, its mode, its window and settings, and its questions as copies taken from
// the bank. Its Submissions are assessment.submission.js's (ticket 03); marking by
// hand and Scores come with ticket 04.
//
// Owner's decisions (2026-10-04, and the build decisions of 2026-10-07):
// - On the ClassSubject, with its own window inside the Semester; not tied to a
//   Session, so no Holiday move.
// - Managed by the ClassSubject's Answering Teacher - the successor once it ended -
//   and read, drafts included, by the Class's homeroom teacher, the Principal and
//   the Vice Principals, who change nothing (staffStandingOf).
// - Created only on a live ACTIVE ClassSubject, in an OPEN Semester of an ACTIVE
//   year. One that ended keeps its Assessments for the successor and takes no new one.
// - ONLINE has questions and the settings; OFFLINE has neither - its marks are
//   entered by hand (ticket 04).
// - A question is copied in: kind, scoring, payload and answer key, so no change to
//   the bank reaches the Assessment. The list is replaced whole, in its order, and a
//   copy left out is removed softly: ticket 03's answers will point at it
//   (2026-10-07). A question written while building one is written to the bank
//   first, through the bank's own route, and then put in (2026-10-07).
// - Points are whole, 1 to 100, default 1 (2026-10-07).
// - A draft until published. A draft may be deleted, softly; a published one is
//   never deleted - it is cancelled, with a reason its Students see, and nothing in
//   it changes afterwards.
// - After publishing a setting changes freely and never voids (answered question 6);
//   closesAt moves either way but never to before now, opensAt only while no
//   Submission exists (ticket 03), and the type is fixed.
// - The questions still change until release (2026-10-07), and with Submissions not
//   void (ticket 03, spec "Changes after publishing"): a change to what a Student is
//   shown - a question added or removed, its text, an option, an image, its scoring -
//   voids them all, saved only while closesAt is ahead or moved ahead in the same
//   request, so everyone can answer again; a change to a key or to points alone
//   re-marks them, and nobody answers again. A copy is edited in place, the bank
//   untouched (editQuestion, owner 2026-10-08). An option or an accepted answer only
//   moved does neither (2026-10-09).
// - One action copies an Assessment into several of the teacher's own live
//   ClassSubjects of the same Subject, Grade Level and Semester; each copy is a
//   draft that then stands alone. All of them, or none. Given a new window, the
//   copies may go to another Semester, last year's quiz used again (2026-10-07).
// - An Assessment whose Semester is over follows the bank's rule for who sees a
//   question (2026-10-07): a teacher of its Subject at its Grade Level now reads it
//   and may copy it, whoever made it - a departed teacher's quizzes included. While
//   its Semester runs it stays its staff's, so no colleague reads a test ahead. One
//   still holding a question private to someone else stays closed to them whole, as
//   if its Semester still ran, until that privacy ends (2026-10-07).
// - The staff's view says of each question whether the bank's has changed, or been
//   archived, since it was copied (2026-10-07): a copy of last year's quiz carries
//   last year's wording and key, and its teacher swaps the bank's in through the list.

const DEFAULT_POINTS = 1;

// The settings of an ONLINE Assessment. An OFFLINE one keeps their defaults.
const SETTINGS = [
    'maxAttempts',
    'acceptLate',
    'timeLimitMinutes',
    'shuffleQuestions',
    'shuffleOptions',
    'showKeyOnRelease',
];

const CHANGED_MEANWHILE = 'This assessment was changed meanwhile. Reload it and try again';

const LIVE = { removedAt: null };

const classSubjectSelect = {
    id: true,
    status: true,
    endedAt: true,
    classId: true,
    subjectId: true,
    semesterId: true,
    teacherMembershipId: true,
    class: {
        select: { id: true, name: true, gradeLevel: true, academicYear: { select: { label: true, status: true } } },
    },
    subject: { select: { id: true, code: true, name: true } },
    semester: { select: { id: true, ordinal: true, status: true, startDate: true, endDate: true } },
};

// The live questions come without their content: enough to count, total and name
// them. The staff's view reads their content apart (snapshotSelect).
const assessmentSelect = {
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
    publishedAt: true,
    cancelledAt: true,
    cancelReason: true,
    copiedFromId: true,
    createdAt: true,
    updatedAt: true,
    classSubject: { select: classSubjectSelect },
    questions: {
        where: LIVE,
        select: { id: true, points: true, sourceQuestionId: true },
        orderBy: { order: 'asc' },
    },
};

// A copy's content with its answer key, which the global omit in
// src/shared/prisma.js leaves out unless a read names it. Only the staff read this.
const snapshotSelect = {
    id: true,
    order: true,
    points: true,
    sourceQuestionId: true,
    kind: true,
    mcqScoring: true,
    payload: true,
    answerKey: true,
};

async function loadClassSubject(id) {
    const row = await prisma.classSubject.findFirst({ where: { id }, select: classSubjectSelect });
    if (!row) throw notFound('Class subject not found');
    return row;
}

async function loadAssessment(id) {
    const row = await prisma.assessment.findFirst({ where: { id, deletedAt: null }, select: assessmentSelect });
    if (!row) throw notFound('Assessment not found');
    return row;
}

// 'KUIS "Bab 3" of MTK in 11A', for messages and log lines.
const describe = (row) =>
    `${row.type} "${row.title}" of ${row.classSubject.subject.code} in ${row.classSubject.class.name}`;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

// A reader is told no (403); anyone the ClassSubject does not concern gets the same
// 404 as another school's - a PENDING one included, which grants nothing.
function assertTeacherStanding(standing, missing) {
    if (standing === 'teacher') return;
    if (standing === null) throw notFound(missing);
    throw forbidden('Only the teacher of this class subject manages its assessments');
}

// The bank's rule for who sees a question, held by an Assessment whose Semester is
// over (owner, 2026-10-07): a teacher of its Subject at its Grade Level now. Such a
// teacher reads it and may copy it, whoever made it, and changes nothing in it.
// While it holds a question still private to someone else, it stays closed to them
// whole (owner, 2026-10-07): no quiz with holes, and the bank's privacy holds here too.
async function isCopyableBy(auth, row) {
    const { classSubject } = row;
    const today = await todayOf(auth.schoolId);
    if (toDay(classSubject.semester.endDate) >= today) return false;
    const pairs = await taughtNowOf(auth.membershipId);
    const teaches = pairs.some(
        (pair) => pair.subjectId === classSubject.subjectId && pair.gradeLevel === classSubject.class.gradeLevel
    );
    if (!teaches) return false;
    const privateHeld = await prisma.assessmentQuestion.count({
        where: { assessmentId: row.id, ...LIVE, sourceQuestion: privateFromWhere(auth.membershipId, today) },
    });
    return privateHeld === 0;
}

// Its staff read it, and so does a teacher who may copy it ('copier').
async function loadReadable(auth, id) {
    const row = await loadAssessment(id);
    const standing =
        (await staffStandingOf(auth, row.classSubject)) ?? ((await isCopyableBy(auth, row)) ? 'copier' : null);
    if (!standing) throw notFound('Assessment not found');
    return { row, standing };
}

// A reader or a copier, who may read it, is told no (403).
async function loadManaged(auth, id) {
    const { row, standing } = await loadReadable(auth, id);
    assertTeacherStanding(standing, 'Assessment not found');
    return row;
}

// A copy's source: one the caller manages, or one they may copy. Anyone else is told
// as for every other write: 403 for a reader, 404 for the rest.
async function loadCopySource(auth, id) {
    const row = await loadAssessment(id);
    const standing = await staffStandingOf(auth, row.classSubject);
    if (standing !== 'teacher' && !(await isCopyableBy(auth, row))) {
        assertTeacherStanding(standing, 'Assessment not found');
    }
    return row;
}

// Nothing in a cancelled Assessment changes (owner, 2026-10-04).
function assertNotCancelled(row) {
    if (row.cancelledAt) throw conflict(`${describe(row)} was cancelled; nothing in it changes`);
}

// Where a new Assessment may go, or a copy: a live ClassSubject in an OPEN Semester
// of an ACTIVE year.
function assertTakesNew(classSubject) {
    if (classSubject.endedAt) {
        throw conflict(
            `${classSubject.subject.code} in ${classSubject.class.name} has ended; ` +
                'set new assessments on the class subject that took its place'
        );
    }
    if (classSubject.semester.status !== 'OPEN') {
        throw conflict(`Semester ${classSubject.semester.ordinal} is not open`);
    }
    if (classSubject.class.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${classSubject.class.academicYear.label} is closed`);
    }
}

// The window lies inside the Semester, from 00:00 of its first day to the end of its
// last, in the school's own zone (spec, defaults taken 4).
async function assertWindow(auth, classSubject, opensAt, closesAt) {
    if (opensAt >= closesAt) throw badRequest('opensAt must come before closesAt');
    const { semester } = classSubject;
    const { start, end } = await semesterSpan(auth.schoolId, semester);
    if (opensAt < start || closesAt > end) {
        throw badRequest(
            `The window must lie inside Semester ${semester.ordinal}: ` +
                `${toDay(semester.startDate)} to ${toDay(semester.endDate)}`
        );
    }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const statusOf = (row) => {
    if (row.cancelledAt) return 'CANCELLED';
    return row.publishedAt ? 'PUBLISHED' : 'DRAFT';
};

const settingsView = (row) =>
    row.mode === 'ONLINE' ? Object.fromEntries(SETTINGS.map((key) => [key, row[key]])) : null;

// Which Class it is, by name, Grade Level and year: two years may each have a 7A.
const classSubjectView = (classSubject) => ({
    id: classSubject.id,
    class: {
        id: classSubject.class.id,
        name: classSubject.class.name,
        gradeLevel: classSubject.class.gradeLevel,
        academicYear: classSubject.class.academicYear.label,
    },
    subject: classSubject.subject,
    semester: { id: classSubject.semester.id, ordinal: classSubject.semester.ordinal },
    ended: classSubject.endedAt !== null,
});

const assessmentView = (row, standing) => ({
    id: row.id,
    classSubject: classSubjectView(row.classSubject),
    type: row.type,
    mode: row.mode,
    title: row.title,
    instructions: row.instructions,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    settings: settingsView(row),
    status: statusOf(row),
    publishedAt: row.publishedAt,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    copiedFromId: row.copiedFromId,
    questionCount: row.questions.length,
    totalPoints: row.questions.reduce((sum, question) => sum + question.points, 0),
    canManage: standing === 'teacher',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

// jsonb keeps keys in an order of its own, so a payload just built and one read back
// compare with their keys sorted, at every level.
const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};
const sameContent = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// A copy's payload or key as a change to it is judged (owner, 2026-10-09): its
// options, correct options and accepted answers in any order. Each Submission keeps
// the order it was shown and names an option by its id, so an option or an accepted
// answer moved voids nothing and re-marks nothing; new attempts take the new order.
const byId = (a, b) => a.id.localeCompare(b.id);
const unorderedOf = (value) =>
    value && {
        ...value,
        ...(value.options ? { options: [...value.options].sort(byId) } : {}),
        ...(value.correctOptionIds ? { correctOptionIds: [...value.correctOptionIds].sort() } : {}),
        ...(value.accepted ? { accepted: [...value.accepted].sort() } : {}),
    };
const sameInAnyOrder = (a, b) => sameContent(unorderedOf(a), unorderedOf(b));

// How the bank's question stands against this copy now, or null with none. Compared
// by content, not by time: archiving moves a question's updatedAt too.
const bankStateOf = (copy, source) =>
    source
        ? {
            changed: !sameContent(copy.payload, source.payload) || !sameContent(copy.answerKey, source.answerKey),
            archived: source.archivedAt !== null,
        }
        : null;

const snapshotView = (row, source) => ({
    id: row.id,
    order: row.order,
    points: row.points,
    sourceQuestionId: row.sourceQuestionId,
    ...questionContentView(row),
    bank: bankStateOf(row, source),
});

// One Assessment with its questions, key included: every caller here is staff, or a
// teacher who may copy it. Each question carries its bank state (2026-10-07).
async function detailOf(id, standing) {
    const [row, questions] = await Promise.all([
        prisma.assessment.findFirst({ where: { id }, select: assessmentSelect }),
        prisma.assessmentQuestion.findMany({
            where: { assessmentId: id, ...LIVE },
            select: snapshotSelect,
            orderBy: { order: 'asc' },
        }),
    ]);
    const sources = await prisma.question.findMany({
        where: { id: { in: questions.map((question) => question.sourceQuestionId).filter(Boolean) } },
        select: { id: true, payload: true, answerKey: true, archivedAt: true },
    });
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    return {
        ...assessmentView(row, standing),
        questions: questions.map((question) => snapshotView(question, sourceById.get(question.sourceQuestionId))),
    };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Every Assessment of the ClassSubject's slot - its Class, Subject and Semester - so
// a successor also finds what an ended assignment left there. Drafts included: only
// staff read this.
async function listForClassSubject(auth, classSubjectId) {
    const classSubject = await loadClassSubject(classSubjectId);
    const standing = await staffStandingOf(auth, classSubject);
    if (!standing) throw notFound('Class subject not found');

    const rows = await prisma.assessment.findMany({
        where: { deletedAt: null, ...slotSessionWhere(classSubject) },
        select: assessmentSelect,
        orderBy: [{ opensAt: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => assessmentView(row, standing));
}

const sameSlot = (a, b) => a.classId === b.classId && a.subjectId === b.subjectId && a.semesterId === b.semesterId;

// What its teacher may copy into a ClassSubject (2026-10-07), of its Subject at its
// Grade Level: every Assessment they manage, in any Semester - a slot holding a live
// ClassSubject of theirs, as answeringTeacherOf decides - and every one of a Semester
// that is over, whoever made it (isCopyableBy: the target is a pair they teach now),
// unless it holds a question still private to someone else.
// Not its own slot's, which its list holds; cancelled ones with their status, deleted
// ones not. The latest Semester first. Only where a new Assessment may go.
async function listCopySources(auth, classSubjectId) {
    const target = await loadClassSubject(classSubjectId);
    assertTeacherStanding(await staffStandingOf(auth, target), 'Class subject not found');
    assertTakesNew(target);

    const pair = { subjectId: target.subjectId, class: { gradeLevel: target.class.gradeLevel } };
    const [managed, today] = await Promise.all([
        prisma.classSubject.findMany({
            where: { ...pair, teacherMembershipId: auth.membershipId, status: 'ACTIVE', endedAt: null },
            select: { classId: true, subjectId: true, semesterId: true },
        }),
        todayOf(auth.schoolId),
    ]);
    const rows = await prisma.assessment.findMany({
        where: {
            deletedAt: null,
            classSubject: pair,
            OR: [
                ...managed.map(slotSessionWhere),
                {
                    classSubject: { semester: { endDate: { lt: toDate(today) } } },
                    questions: { none: { ...LIVE, sourceQuestion: privateFromWhere(auth.membershipId, today) } },
                },
            ],
        },
        select: assessmentSelect,
        orderBy: [{ classSubject: { semester: { startDate: 'desc' } } }, { opensAt: 'desc' }, { createdAt: 'desc' }],
    });
    return rows
        .filter((row) => !sameSlot(row.classSubject, target))
        .map((row) => {
            const manages = managed.some((slot) => sameSlot(row.classSubject, slot));
            return assessmentView(row, manages ? 'teacher' : 'copier');
        });
}

async function getAssessment(auth, id) {
    const { row, standing } = await loadReadable(auth, id);
    return detailOf(row.id, standing);
}

// An image one of its questions holds, for its staff, who may not see the bank
// question it came from. Its Students read them through their own Submission
// (assessment.submission.js, ticket 03).
async function readImage(auth, id, imageId) {
    const { row } = await loadReadable(auth, id);
    const questions = await prisma.assessmentQuestion.findMany({
        where: { assessmentId: row.id, ...LIVE },
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
// Writing
// ---------------------------------------------------------------------------

// An empty one is no instructions; one with only markup the sanitiser drops is
// refused, as a question's body is.
const instructionsOf = (html) => (html ? cleanText(html) : null);

async function create(auth, classSubjectId, body) {
    const classSubject = await loadClassSubject(classSubjectId);
    assertTeacherStanding(await staffStandingOf(auth, classSubject), 'Class subject not found');
    assertTakesNew(classSubject);
    await assertWindow(auth, classSubject, body.opensAt, body.closesAt);

    const row = await prisma.assessment.create({
        data: {
            ...body,
            instructions: instructionsOf(body.instructions),
            classSubjectId,
            createdByUserId: auth.userId,
        },
        select: assessmentSelect,
    });
    log.info(`${describe(row)} created (${row.mode})`);
    return assessmentView(row, 'teacher');
}

// Title, instructions, window and settings; the type only while a draft, and the
// mode never - an OFFLINE one has no settings. Published, closesAt may close it
// early or keep it open longer, never to before now (answered question 6). opensAt
// moves only while no Submission exists (ticket 03): an attempt already started
// would have begun before it opened.
async function update(auth, id, patch) {
    const row = await loadManaged(auth, id);
    assertNotCancelled(row);
    if (row.publishedAt && patch.type && patch.type !== row.type) {
        throw conflict(`${describe(row)} is published; its type is fixed`);
    }
    if (row.mode === 'OFFLINE' && SETTINGS.some((key) => key in patch)) {
        throw badRequest('An offline assessment has no settings');
    }
    if (patch.opensAt || patch.closesAt) {
        await assertWindow(auth, row.classSubject, patch.opensAt ?? row.opensAt, patch.closesAt ?? row.closesAt);
    }
    if (row.publishedAt && patch.closesAt && patch.closesAt < new Date()) {
        throw badRequest(`${describe(row)} is published; closesAt can be brought forward, but not to before now`);
    }
    const opensMoves = patch.opensAt && patch.opensAt.getTime() !== row.opensAt.getTime();
    if (opensMoves && (await submissionCountOf(row.id)) > 0) {
        throw conflict(`${describe(row)} has submissions; its opensAt is fixed`);
    }

    const data = 'instructions' in patch ? { ...patch, instructions: instructionsOf(patch.instructions) } : patch;
    const claimed = await prisma.assessment.updateMany({
        where: { id: row.id, deletedAt: null, cancelledAt: null, updatedAt: row.updatedAt },
        data,
    });
    if (claimed.count === 0) throw conflict(CHANGED_MEANWHILE);
    log.info(`${describe(row)} edited`);
    return detailOf(row.id, 'teacher');
}

// What a copy of a question holds: its content and key, as the source has them.
const copyOf = (question) => ({
    kind: question.kind,
    mcqScoring: question.mcqScoring,
    payload: question.payload,
    answerKey: question.answerKey ?? Prisma.DbNull,
});

// A closesAt sent along with a change to the questions, checked as an edit's is.
async function assertClosesAt(auth, row, closesAt, now) {
    await assertWindow(auth, row.classSubject, row.opensAt, closesAt);
    if (row.publishedAt && closesAt < now) {
        throw badRequest(`${describe(row)} is published; closesAt can be brought forward, but not to before now`);
    }
}

// What a change to a published Assessment's questions does to its Submissions not
// void (ticket 03): 'void' when what a Student is shown changed, 'remark' when only a
// key or points did, or null. Voiding needs closesAt ahead - the one sent in the same
// request, else the Assessment's own - so everyone can answer again. After the first
// release the questions are locked: ticket 04 refuses here.
async function submissionEffectOf(row, { shownChanged, markChanged, closesAt }, now) {
    if (!row.publishedAt) return null;
    if (shownChanged) {
        const live = await liveSubmissionCountOf(row.id);
        if (live > 0 && (closesAt ?? row.closesAt) <= now) {
            throw conflict(
                `This change voids ${live} submission(s) to ${describe(row)}; ` +
                    'send a closesAt still ahead with it, so its students can answer again'
            );
        }
        return 'void';
    }
    return markChanged ? 'remark' : null;
}

// The effect, in the caller's transaction. Voiding catches a Submission started
// since the count above too.
async function applySubmissionEffect(tx, row, effect, { reason, questionIds }, now) {
    if (effect === 'void') return voidSubmissions(tx, row.id, reason, now);
    if (effect === 'remark') return remarkQuestions(tx, questionIds);
    return 0;
}

const effectNote = (effect, count) => {
    if (effect === 'void' && count) return `, ${count} submission(s) voided`;
    if (effect === 'remark' && count) return `, ${count} answer(s) marked again`;
    return '';
};

// The whole question list, in its order. A copy the Assessment holds is named by its
// id, keeping its content; a bank question by its questionId, copied now - one of
// the Assessment's Subject and Grade Level, not archived, that the caller sees. A
// copy left out is removed, softly. Points are kept unless given; a new one gets 1.
// A copy's own wording, options or key change in place: editQuestion.
//
// Published, with Submissions (ticket 03): a question added or removed voids them;
// points changed re-mark them; a new order changes nothing, since each Submission
// keeps the order it was shown.
async function replaceQuestions(auth, id, { questions, closesAt }) {
    const row = await loadManaged(auth, id);
    assertNotCancelled(row);
    if (row.mode === 'OFFLINE') throw conflict(`${describe(row)} is offline; it has no questions`);

    const held = new Map(row.questions.map((question) => [question.id, question]));
    const stray = questions.filter((item) => item.id && !held.has(item.id)).map((item) => item.id);
    if (stray.length) throw badRequest('A question named is not in this assessment', { ids: stray });

    const kept = questions.filter((item) => item.id).map((item) => held.get(item.id));
    const keptSources = new Set(kept.map((question) => question.sourceQuestionId));
    const fromBank = questions.filter((item) => item.questionId).map((item) => item.questionId);
    const twice = fromBank.filter((questionId) => keptSources.has(questionId));
    if (twice.length) throw badRequest('A question is in this assessment already', { questionIds: twice });

    const { subject, class: { gradeLevel } } = row.classSubject;
    const picked = fromBank.length
        ? await pickableQuestionsOf(auth, fromBank, { subjectId: subject.id, gradeLevel })
        : [];
    const pickedById = new Map(picked.map((question) => [question.id, question]));
    const unknown = fromBank.filter((questionId) => !pickedById.has(questionId));
    if (unknown.length) {
        throw badRequest(`Pick live questions from the bank of ${subject.code} grade ${gradeLevel}`, {
            questionIds: unknown,
        });
    }

    const now = new Date();
    if (closesAt) await assertClosesAt(auth, row, closesAt, now);
    const keptIds = new Set(kept.map((question) => question.id));
    const pointsChanged = questions
        .filter((item) => item.id && item.points && item.points !== held.get(item.id).points)
        .map((item) => item.id);
    const effect = await submissionEffectOf(
        row,
        {
            shownChanged: fromBank.length > 0 || row.questions.some((question) => !keptIds.has(question.id)),
            markChanged: pointsChanged.length > 0,
            closesAt,
        },
        now
    );

    const affected = await prisma.$transaction(async (tx) => {
        const claimed = await tx.assessment.updateMany({
            where: { id: row.id, deletedAt: null, cancelledAt: null, updatedAt: row.updatedAt },
            data: { updatedAt: now, ...(closesAt ? { closesAt } : {}) },
        });
        if (claimed.count === 0) throw conflict(CHANGED_MEANWHILE);

        await tx.assessmentQuestion.updateMany({
            where: { assessmentId: row.id, ...LIVE, id: { notIn: kept.map((question) => question.id) } },
            data: { removedAt: now },
        });
        const fresh = [];
        for (const [index, item] of questions.entries()) {
            if (item.id) {
                await tx.assessmentQuestion.updateMany({
                    where: { id: item.id, assessmentId: row.id },
                    data: { order: index + 1, ...(item.points ? { points: item.points } : {}) },
                });
            } else {
                fresh.push({
                    ...copyOf(pickedById.get(item.questionId)),
                    assessmentId: row.id,
                    sourceQuestionId: item.questionId,
                    order: index + 1,
                    points: item.points ?? DEFAULT_POINTS,
                });
            }
        }
        if (fresh.length) await tx.assessmentQuestion.createMany({ data: fresh });
        return applySubmissionEffect(
            tx,
            row,
            effect,
            { reason: 'A question was added or removed', questionIds: pointsChanged },
            now
        );
    });

    log.info(`${describe(row)}: questions saved, ${questions.length} in it${effectNote(effect, affected)}`);
    return detailOf(row.id, 'teacher');
}

// A copy's own content, key or points, changed in place (owner, 2026-10-08); the
// bank's question is untouched, and the staff's view then shows it changed. The body
// is a bank question's, of the kind the copy has, its options sent back by id.
//
// Published, with Submissions (ticket 03): a change to what a Student is shown - the
// text, an option, an image, or the scoring, which turns a choice of one into a
// choice of several - voids them; a change to the key or the points alone re-marks
// them, and nobody answers again. Say 20 handed in and the key of question 3 should
// have been B: fixed here, the 20 are marked again. Options moved, the same ids and
// text, change nothing for them (sameInAnyOrder, 2026-10-09).
async function editQuestion(auth, id, questionId, body) {
    const row = await loadManaged(auth, id);
    assertNotCancelled(row);
    const copy = await prisma.assessmentQuestion.findFirst({
        where: { id: questionId, assessmentId: row.id, ...LIVE },
        select: snapshotSelect,
    });
    if (!copy) throw notFound('Question not found');
    if (body.kind !== copy.kind) throw badRequest(`A question's kind never changes: this one is ${copy.kind}`);

    const { points = copy.points, closesAt } = body;
    const { payload, answerKey } = await payloadAndKeyOf(auth, body, copy);
    const mcqScoring = body.kind === 'MCQ' ? body.mcqScoring : null;
    // An ESSAY has no key: the copy reads back null, and payloadAndKeyOf gives DbNull.
    const key = answerKey === Prisma.DbNull ? null : answerKey;
    const now = new Date();
    if (closesAt) await assertClosesAt(auth, row, closesAt, now);
    const effect = await submissionEffectOf(
        row,
        {
            shownChanged: !sameInAnyOrder(payload, copy.payload) || mcqScoring !== copy.mcqScoring,
            markChanged: !sameInAnyOrder(key, copy.answerKey) || points !== copy.points,
            closesAt,
        },
        now
    );

    const affected = await prisma.$transaction(async (tx) => {
        const claimed = await tx.assessment.updateMany({
            where: { id: row.id, deletedAt: null, cancelledAt: null, updatedAt: row.updatedAt },
            data: { updatedAt: now, ...(closesAt ? { closesAt } : {}) },
        });
        if (claimed.count === 0) throw conflict(CHANGED_MEANWHILE);

        await tx.assessmentQuestion.updateMany({
            where: { id: copy.id, assessmentId: row.id, ...LIVE },
            data: { mcqScoring, payload, answerKey, points },
        });
        const reason = 'A question was changed';
        return applySubmissionEffect(tx, row, effect, { reason, questionIds: [copy.id] }, now);
    });

    log.info(`${describe(row)}: a question edited${effectNote(effect, affected)}`);
    return detailOf(row.id, 'teacher');
}

// Once only. An ONLINE one needs a question; an OFFLINE one has none. The claim
// holds the version read, so a list emptied meanwhile is not published.
async function publish(auth, id) {
    const row = await loadManaged(auth, id);
    if (row.publishedAt) throw conflict(`${describe(row)} is published already`);
    if (row.mode === 'ONLINE' && row.questions.length === 0) {
        throw conflict(`Add at least one question to ${describe(row)} before publishing it`);
    }

    // Ticket 06 writes assessment.published here, in one transaction with the claim.
    const claimed = await prisma.assessment.updateMany({
        where: { id: row.id, deletedAt: null, publishedAt: null, updatedAt: row.updatedAt },
        data: { publishedAt: new Date() },
    });
    if (claimed.count === 0) throw conflict(CHANGED_MEANWHILE);
    log.info(`${describe(row)} published`);
    return detailOf(row.id, 'teacher');
}

// "Sekali buat, salinan per kelas" (owner, 2026-10-04): a draft in each ClassSubject
// named, with the same type, mode, window, settings and questions - the copies are
// copied again, keys included. Each target is the caller's own live ClassSubject of
// the same Subject, Grade Level and Semester; one that is not refuses the whole
// action, naming it.
//
// Given a new window (owner, 2026-10-07), the copies take it, and the targets may lie
// in another Semester - last year's quiz used again this year. The source is one the
// caller manages - a closed year ends no ClassSubject, so its teacher keeps it - or
// one of a Semester that is over, of a pair they teach now (loadCopySource).
async function copy(auth, id, body) {
    const source = await loadCopySource(auth, id);
    const { subject, class: sourceClass, semester } = source.classSubject;
    const newWindow = body.opensAt !== undefined;
    const opensAt = body.opensAt ?? source.opensAt;
    const closesAt = body.closesAt ?? source.closesAt;

    const targets = await prisma.classSubject.findMany({
        where: {
            id: { in: body.classSubjectIds },
            teacherMembershipId: auth.membershipId,
            status: 'ACTIVE',
            endedAt: null,
            subjectId: subject.id,
            ...(newWindow ? {} : { semesterId: semester.id }),
            class: { gradeLevel: sourceClass.gradeLevel },
        },
        select: classSubjectSelect,
    });
    const found = new Set(targets.map((target) => target.id));
    const refused = body.classSubjectIds.filter((targetId) => !found.has(targetId));
    if (refused.length) {
        const where = `${subject.code} grade ${sourceClass.gradeLevel}`;
        const sameSemester = `in Semester ${semester.ordinal} of ${sourceClass.academicYear.label}`;
        throw badRequest(
            newWindow
                ? `Copy only to your own live class subjects of ${where}`
                : `Copy only to your own live class subjects of ${where} ${sameSemester}, or give a new window`,
            { classSubjectIds: refused }
        );
    }
    targets.forEach(assertTakesNew);
    // The window fits each target's Semester, checked once per Semester: without a
    // new window there is one, the source's.
    const semesters = new Map(targets.map((target) => [target.semesterId, target]));
    for (const target of semesters.values()) await assertWindow(auth, target, opensAt, closesAt);

    const questions = await prisma.assessmentQuestion.findMany({
        where: { assessmentId: source.id, ...LIVE },
        select: snapshotSelect,
        orderBy: { order: 'asc' },
    });
    const fields = {
        type: source.type,
        mode: source.mode,
        title: source.title,
        instructions: source.instructions,
        opensAt,
        closesAt,
        ...Object.fromEntries(SETTINGS.map((key) => [key, source[key]])),
    };

    const ids = await prisma.$transaction(async (tx) => {
        const created = [];
        for (const target of targets) {
            const row = await tx.assessment.create({
                data: { ...fields, classSubjectId: target.id, createdByUserId: auth.userId, copiedFromId: source.id },
                select: { id: true },
            });
            if (questions.length) {
                await tx.assessmentQuestion.createMany({
                    data: questions.map((question) => ({
                        ...copyOf(question),
                        assessmentId: row.id,
                        sourceQuestionId: question.sourceQuestionId,
                        order: question.order,
                        points: question.points,
                    })),
                });
            }
            created.push(row.id);
        }
        return created;
    });

    // With the year: last year's 11A and this year's are both 11A.
    const names = targets.map((target) => `${target.class.name} ${target.class.academicYear.label}`);
    log.info(`${describe(source)} copied to ${names.join(', ')}${newWindow ? ', with a new window' : ''}`);
    return Promise.all(ids.map((copyId) => detailOf(copyId, 'teacher')));
}

// A published Assessment, called off. Not an approval, so no ApprovalAudit; its
// Submissions and Scores will stay, and the grading slice does not count them.
async function cancel(auth, id, { reason }) {
    const row = await loadManaged(auth, id);
    if (!row.publishedAt) throw conflict(`${describe(row)} is a draft; delete it instead`);
    if (row.cancelledAt) throw conflict(`${describe(row)} is cancelled already`);

    const claimed = await prisma.assessment.updateMany({
        where: { id: row.id, publishedAt: { not: null }, cancelledAt: null },
        data: { cancelledAt: new Date(), cancelReason: reason, cancelledByUserId: auth.userId },
    });
    if (claimed.count === 0) throw conflict(`${describe(row)} is cancelled already`);
    log.info(`${describe(row)} cancelled`);
    return detailOf(row.id, 'teacher');
}

// A draft only, and softly. A published one is cancelled instead.
async function remove(auth, id) {
    const row = await loadManaged(auth, id);
    if (row.publishedAt) {
        throw conflict(`${describe(row)} is published; a published assessment is never deleted - cancel it`);
    }

    const removed = await prisma.assessment.updateMany({
        where: { id: row.id, publishedAt: null, deletedAt: null },
        data: { deletedAt: new Date() },
    });
    if (removed.count === 0) throw conflict(CHANGED_MEANWHILE);
    log.info(`${describe(row)} deleted (draft)`);
}

export {
    listForClassSubject,
    listCopySources,
    getAssessment,
    readImage,
    create,
    update,
    replaceQuestions,
    editQuestion,
    publish,
    copy,
    cancel,
    remove,
};
