import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';

import { prisma } from '../../shared/prisma.js';
import { isPrincipalOrVice } from '../../shared/guards.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { getStorage } from '../../shared/storage.js';
import { MIME } from '../../shared/upload.js';
import { createLogger } from '../../lib/helpers.js';
import { cleanText } from '../content/content.service.js';

const log = createLogger('Assessment');

// The question bank (assessment ticket 01): the questions a School's teachers
// write, kept per Subject x Grade Level. Assessments (ticket 02) draw on it by
// copying a question (pickableQuestionsOf), so nothing done here reaches an
// Assessment. Students never reach it: the routes answer them 404 before this file
// runs.
//
// Owner's decisions (2026-10-04, and the build decisions of 2026-10-05):
// - Who sees a question: a teacher teaching its Subject at its Grade Level now
//   (taughtNowOf), its author always, and the Principal and Vice Principals, who
//   read the whole bank. A leader who also teaches writes for what they teach, as a
//   teacher (2026-10-05).
// - Whoever sees a question sees its answer key: a teacher needs the answer before
//   using a colleague's question (2026-10-05).
// - A teacher writes, and duplicates into, only a Subject and Grade Level they
//   teach now. Only the author edits, archives and restores, while their membership
//   is live. A departed author's questions stay, read and used, and nobody edits
//   them.
// - Stored as two JSON columns, payload and answerKey, each carrying the version of
//   its shape (2026-10-05). See the Question model.
// - Archiving is soft, and the author may restore. An archived question leaves the
//   pick list; its author and the leaders still read it.
// - A duplicate belongs to whoever made it, keeps the Subject, may take another
//   Grade Level they teach, and shares the original's images.
// - Images, JPG or PNG up to 5 MB, are uploaded first and named by id when the
//   question is saved (2026-10-05). Never deleted, as Content's files are not.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['jpg', 'png'];

// The version of payload's and answerKey's shape. A change to the shape of a kind
// already stored raises it, so old rows can be told from new ones.
const SHAPE_VERSION = 1;

const questionSelect = {
    id: true,
    subjectId: true,
    gradeLevel: true,
    kind: true,
    mcqScoring: true,
    payload: true,
    answerKey: true,
    authorMembershipId: true,
    duplicatedFromId: true,
    archivedAt: true,
    createdAt: true,
    updatedAt: true,
    subject: { select: { id: true, code: true, name: true } },
    author: { select: { id: true, status: true, user: { select: { fullName: true } } } },
};

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

// The Subject x Grade Level pairs a teacher teaches now: a live ACTIVE ClassSubject
// of the Subject, in a Class at that Grade Level, in an ACTIVE Academic Year (spec,
// "Who sees it"). A PENDING one grants nothing, and one that ended stops granting.
async function taughtNowOf(membershipId) {
    const rows = await prisma.classSubject.findMany({
        where: {
            teacherMembershipId: membershipId,
            status: 'ACTIVE',
            endedAt: null,
            class: { academicYear: { status: 'ACTIVE' } },
        },
        select: { subjectId: true, class: { select: { gradeLevel: true } } },
    });
    const pairs = new Map(
        rows.map((row) => [
            `${row.subjectId}:${row.class.gradeLevel}`,
            { subjectId: row.subjectId, gradeLevel: row.class.gradeLevel },
        ])
    );
    return [...pairs.values()];
}

// What the caller is to the bank: a reader (the Principal or a Vice Principal), and
// the pairs they teach now. A leader who teaches has both.
async function bankStandingOf(auth) {
    const [reader, pairs] = await Promise.all([isPrincipalOrVice(auth.membershipId), taughtNowOf(auth.membershipId)]);
    return { reader, pairs };
}

// The questions a caller sees, as a where. A reader sees all of them. A teacher
// sees their own, archived ones included, and the live ones of a pair they teach.
function visibleWhere(auth, standing) {
    if (standing.reader) return {};
    const taughtLive = standing.pairs.length ? [{ archivedAt: null, OR: standing.pairs }] : [];
    return { OR: [{ authorMembershipId: auth.membershipId }, ...taughtLive] };
}

// A question the caller sees, or the 404 a question of another school gets.
async function loadVisibleQuestion(auth, standing, id) {
    const row = await prisma.question.findFirst({
        where: { AND: [{ id }, visibleWhere(auth, standing)] },
        select: questionSelect,
    });
    if (!row) throw notFound('Question not found');
    return row;
}

// A question the caller wrote, for a change only its author makes. Anyone else who
// sees it is told no (403); the caller's own membership is live, or the request
// would not have got here.
async function loadOwnQuestion(auth, id) {
    const row = await loadVisibleQuestion(auth, await bankStandingOf(auth), id);
    if (row.authorMembershipId !== auth.membershipId) throw forbidden('Only its author changes a question');
    return row;
}

function assertTeaches(standing, subjectId, gradeLevel) {
    const teaches = standing.pairs.some((pair) => pair.subjectId === subjectId && pair.gradeLevel === gradeLevel);
    if (!teaches) throw forbidden('You write questions only for a subject and grade level you teach now');
}

// ---------------------------------------------------------------------------
// Payload and answer key
// ---------------------------------------------------------------------------

const imageIdsOf = (payload) =>
    [payload.imageId, ...(payload.options ?? []).map((option) => option.imageId)].filter(Boolean);

// What a kind holds besides the body and its image: the visible part of it, and
// its key. view joins them back for the staff, who all see the key.
const KINDS = {
    MCQ: {
        visible: (body) => ({
            options: body.options.map((option) => ({
                id: option.id ?? crypto.randomUUID(),
                text: option.text || null,
                imageId: option.imageId ?? null,
            })),
        }),
        // payload.options are body.options in the same order, with their ids.
        key: (body, payload) => ({
            correctOptionIds: payload.options
                .filter((_option, index) => body.options[index].correct)
                .map((option) => option.id),
        }),
        view: (payload, key) => ({
            options: payload.options.map((option) => ({
                ...option,
                correct: key.correctOptionIds.includes(option.id),
            })),
        }),
    },
    TF: {
        visible: () => ({}),
        key: (body) => ({ value: body.value }),
        view: (_payload, key) => ({ value: key.value }),
    },
    SHORT: {
        visible: () => ({}),
        key: (body) => ({ accepted: body.accepted }),
        view: (_payload, key) => ({ accepted: key.accepted }),
    },
    ESSAY: {
        visible: () => ({}),
        key: () => null,
        view: () => ({}),
    },
};

// payload and answerKey from a body. An option sent with an id keeps it, and must
// be one the question already has; a new option gets a new id. Every image named
// is the caller's own upload, or one the question already holds.
async function payloadAndKeyOf(auth, body, existing = null) {
    const known = new Set(existing?.kind === 'MCQ' ? existing.payload.options.map((option) => option.id) : []);
    const stray = (body.options ?? []).filter((option) => option.id && !known.has(option.id));
    if (stray.length) {
        throw badRequest('An option id does not belong to this question', {
            optionIds: stray.map((option) => option.id),
        });
    }

    const kind = KINDS[body.kind];
    const payload = {
        v: SHAPE_VERSION,
        body: cleanText(body.body),
        imageId: body.imageId ?? null,
        ...kind.visible(body),
    };
    await assertImagesUsable(auth, imageIdsOf(payload), existing);

    // An ESSAY has no key. Prisma writes a nullable Json column's NULL only when
    // named as DbNull.
    const key = kind.key(body, payload);
    return { payload, answerKey: key ? { v: SHAPE_VERSION, ...key } : Prisma.DbNull };
}

async function assertImagesUsable(auth, imageIds, existing) {
    const held = new Set(existing ? imageIdsOf(existing.payload) : []);
    const fresh = [...new Set(imageIds)].filter((imageId) => !held.has(imageId));
    if (!fresh.length) return;

    const own = await prisma.questionImage.findMany({
        where: { id: { in: fresh }, uploadedByMembershipId: auth.membershipId },
        select: { id: true },
    });
    const ownIds = new Set(own.map((image) => image.id));
    const unknown = fresh.filter((imageId) => !ownIds.has(imageId));
    if (unknown.length) throw badRequest('Use an image you uploaded', { imageIds: unknown });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// A question's content with its key joined in, for the staff, who all see the key:
// a bank Question, or an Assessment's copy of one (assessment.service.js).
const questionContentView = (row) => ({
    kind: row.kind,
    mcqScoring: row.mcqScoring,
    body: row.payload.body,
    imageId: row.payload.imageId,
    ...KINDS[row.kind].view(row.payload, row.answerKey),
});

const questionView = (auth, row) => ({
    id: row.id,
    subject: row.subject,
    gradeLevel: row.gradeLevel,
    ...questionContentView(row),
    author: {
        membershipId: row.author.id,
        fullName: row.author.user.fullName,
        left: row.author.status !== 'ACTIVE',
    },
    mine: row.authorMembershipId === auth.membershipId,
    canEdit: row.authorMembershipId === auth.membershipId,
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt,
    duplicatedFromId: row.duplicatedFromId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const imageView = (row) => ({ id: row.id, mimeType: row.mimeType, size: row.size, createdAt: row.createdAt });

const describe = (row) => `${row.kind} question for ${row.subject.code} grade ${row.gradeLevel}`;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// The pick list by default: live questions only. archived=true lists the archived
// ones instead - the caller's own, or every one for a leader.
async function listQuestions(auth, query) {
    const standing = await bankStandingOf(auth);
    const rows = await prisma.question.findMany({
        where: {
            AND: [
                visibleWhere(auth, standing),
                { archivedAt: query.archived ? { not: null } : null },
                ...(query.mine ? [{ authorMembershipId: auth.membershipId }] : []),
                ...(query.subjectId ? [{ subjectId: query.subjectId }] : []),
                ...(query.gradeLevel ? [{ gradeLevel: query.gradeLevel }] : []),
                ...(query.kind ? [{ kind: query.kind }] : []),
            ],
        },
        select: questionSelect,
        orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => questionView(auth, row));
}

async function getQuestion(auth, id) {
    return questionView(auth, await loadVisibleQuestion(auth, await bankStandingOf(auth), id));
}

// The bank questions an Assessment may take, of those named: ones the caller sees,
// of the Assessment's Subject and Grade Level, not archived (assessment ticket 02).
// Their content and key, for the copy; the caller checks that every one was found.
async function pickableQuestionsOf(auth, ids, { subjectId, gradeLevel }) {
    const standing = await bankStandingOf(auth);
    return prisma.question.findMany({
        where: { AND: [visibleWhere(auth, standing), { id: { in: ids }, subjectId, gradeLevel, archivedAt: null }] },
        select: { id: true, kind: true, mcqScoring: true, payload: true, answerKey: true },
    });
}

const reload = async (auth, id) =>
    questionView(auth, await prisma.question.findFirst({ where: { id }, select: questionSelect }));

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function createQuestion(auth, body) {
    assertTeaches(await bankStandingOf(auth), body.subjectId, body.gradeLevel);
    const { payload, answerKey } = await payloadAndKeyOf(auth, body);

    const row = await prisma.question.create({
        data: {
            subjectId: body.subjectId,
            gradeLevel: body.gradeLevel,
            kind: body.kind,
            mcqScoring: body.kind === 'MCQ' ? body.mcqScoring : null,
            payload,
            answerKey,
            authorMembershipId: auth.membershipId,
        },
        select: questionSelect,
    });
    log.info(`${describe(row)} written`);
    return questionView(auth, row);
}

// The whole content again, of the kind the question has: its Subject and Grade
// Level never change (the schema refuses them). The claim holds the version read,
// so of two edits at once the second is told to reload rather than overwrite.
async function updateQuestion(auth, id, body) {
    const row = await loadOwnQuestion(auth, id);
    if (body.kind !== row.kind) throw badRequest(`A question's kind never changes: this one is ${row.kind}`);
    const { payload, answerKey } = await payloadAndKeyOf(auth, body, row);

    const claimed = await prisma.question.updateMany({
        where: { id: row.id, authorMembershipId: auth.membershipId, updatedAt: row.updatedAt },
        data: { mcqScoring: body.kind === 'MCQ' ? body.mcqScoring : null, payload, answerKey },
    });
    if (claimed.count === 0) throw conflict('This question was changed meanwhile. Reload it and edit again');
    log.info(`${describe(row)} edited`);
    return reload(auth, row.id);
}

// A copy owned by the caller, of a question they see, into a Grade Level of the
// same Subject they teach now - its own, unless another is named. The images are
// shared, not copied: files are never deleted, so sharing is safe.
async function duplicateQuestion(auth, id, { gradeLevel }) {
    const standing = await bankStandingOf(auth);
    const source = await loadVisibleQuestion(auth, standing, id);
    const targetGrade = gradeLevel ?? source.gradeLevel;
    assertTeaches(standing, source.subjectId, targetGrade);

    const row = await prisma.question.create({
        data: {
            subjectId: source.subjectId,
            gradeLevel: targetGrade,
            kind: source.kind,
            mcqScoring: source.mcqScoring,
            payload: source.payload,
            answerKey: source.answerKey ?? Prisma.DbNull,
            authorMembershipId: auth.membershipId,
            duplicatedFromId: source.id,
        },
        select: questionSelect,
    });
    log.info(`${describe(source)} duplicated to grade ${targetGrade}`);
    return questionView(auth, row);
}

// Soft, and only by the author. An Assessment that holds it holds a copy, so it is
// untouched (ticket 02).
async function archiveQuestion(auth, id) {
    const row = await loadOwnQuestion(auth, id);
    const claimed = await prisma.question.updateMany({
        where: { id: row.id, authorMembershipId: auth.membershipId, archivedAt: null },
        data: { archivedAt: new Date() },
    });
    if (claimed.count === 0) throw conflict('This question is archived already');
    log.info(`${describe(row)} archived`);
    return reload(auth, row.id);
}

// The author bringing an archived question back to the pick list (owner, 2026-10-05).
async function restoreQuestion(auth, id) {
    const row = await loadOwnQuestion(auth, id);
    const claimed = await prisma.question.updateMany({
        where: { id: row.id, authorMembershipId: auth.membershipId, archivedAt: { not: null } },
        data: { archivedAt: null },
    });
    if (claimed.count === 0) throw conflict('This question is not archived');
    log.info(`${describe(row)} restored`);
    return reload(auth, row.id);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

// An image for a question not saved yet, or one being edited. The type was read
// from its bytes by singleFile. Stored under questions/<schoolId>/; a failure
// after the file is written removes it again, as Content's files do.
async function uploadImage(auth, file) {
    const type = file.detectedType;
    const storage = getStorage();
    const storageKey = await storage.save(file.buffer, {
        folder: `questions/${auth.schoolId}`,
        originalName: `image.${type}`,
    });

    let row;
    try {
        row = await prisma.questionImage.create({
            data: { storageKey, mimeType: MIME[type], size: file.size, uploadedByMembershipId: auth.membershipId },
        });
    } catch (error) {
        await storage.remove(storageKey);
        throw error;
    }
    log.info(`Question image uploaded (${type.toUpperCase()})`);
    return imageView(row);
}

const imageFileOf = async (image) => ({
    buffer: await getStorage().read(image.storageKey),
    contentType: image.mimeType,
});

// The uploader's own image, for the preview before a question holds it. To anyone
// else it does not exist.
async function readOwnImage(auth, imageId) {
    const image = await prisma.questionImage.findFirst({
        where: { id: imageId, uploadedByMembershipId: auth.membershipId },
    });
    if (!image) throw notFound('Image not found');
    return imageFileOf(image);
}

// An image a question holds, for whoever sees the question. One the question does
// not hold is a 404, so an id alone opens nothing.
async function readQuestionImage(auth, id, imageId) {
    const row = await loadVisibleQuestion(auth, await bankStandingOf(auth), id);
    if (!imageIdsOf(row.payload).includes(imageId)) throw notFound('Image not found');

    const image = await prisma.questionImage.findFirst({ where: { id: imageId } });
    if (!image) throw notFound('Image not found');
    return imageFileOf(image);
}

export {
    MAX_IMAGE_BYTES,
    IMAGE_TYPES,
    imageIdsOf,
    imageFileOf,
    questionContentView,
    pickableQuestionsOf,
    taughtNowOf,
    listQuestions,
    getQuestion,
    createQuestion,
    updateQuestion,
    duplicateQuestion,
    archiveQuestion,
    restoreQuestion,
    uploadImage,
    readOwnImage,
    readQuestionImage,
};
