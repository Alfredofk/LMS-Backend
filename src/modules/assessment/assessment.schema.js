import { z } from 'zod';

import { date } from '../holidays/holidays.schema.js';

// The question bank (assessment ticket 01), Assessments (ticket 02) and answering
// them (ticket 03). Only the shape is checked here, a question's rules per kind
// included. Who may write for which Subject and Grade Level, whose images may be
// named, sanitising the body, and which answer a question takes are the services'.

const id = z.string().min(1);

const idParams = z.object({ id });
const imageIdParams = z.object({ imageId: id });
const questionImageParams = z.object({ id, imageId: id });

const gradeLevel = z.coerce.number().int().min(1).max(13);

const KINDS = ['MCQ', 'TF', 'SHORT', 'ESSAY'];
const MCQ_SCORINGS = ['SINGLE', 'ALL_OR_NOTHING', 'PARTIAL'];

// ---- a question's content, per kind ----

// Rich text from the teacher's editor: HTML, sanitised by the service as Content's
// TEXT is. The limit is on what arrives.
const body = z.string().max(50_000, 'The question is too long');

// An option is plain text, an image, or both. An option the question already has
// is sent back with its id, so an answer key or an image stays on it.
const option = z
    .strictObject({
        id: id.optional(),
        text: z.string().trim().max(500, 'An option is too long').optional(),
        imageId: id.optional(),
        correct: z.boolean(),
    })
    .refine((value) => Boolean(value.text) || Boolean(value.imageId), 'Give the option a text or an image');

const options = z
    .array(option)
    .min(2, 'An MCQ has 2 to 6 options')
    .max(6, 'An MCQ has 2 to 6 options')
    .refine((list) => {
        const ids = list.map((item) => item.id).filter(Boolean);
        return new Set(ids).size === ids.length;
    }, 'An option is named twice');

// SINGLE: exactly one correct option. ALL_OR_NOTHING and PARTIAL: at least one
// (owner, 2026-10-04).
const correctCount = (value) => value.options.filter((item) => item.correct).length;

// Compared at marking ignoring letter case and spaces (ticket 03); kept as typed.
const accepted = z
    .array(z.string().trim().min(1, 'An accepted answer is empty').max(200, 'An accepted answer is too long'))
    .min(1, 'Give at least one accepted answer')
    .max(20, 'At most 20 accepted answers');

// Private to its author and the leaders up to this day, 'YYYY-MM-DD', included;
// null is not private (owner, 2026-10-07). On an edit, left out keeps what it was.
// Whether the day lies within a year from today is the service's: today is the
// school's own date.
const privateUntil = date.nullable().optional();

// The four kinds, each with what it holds and nothing else. `extra` is what a
// new question names besides: its Subject and Grade Level, which an edit never
// changes, and whether it is private, which both name.
const questionUnion = (extra) =>
    z.discriminatedUnion('kind', [
        z
            .strictObject({
                kind: z.literal('MCQ'),
                ...extra,
                body,
                imageId: id.optional(),
                mcqScoring: z.enum(MCQ_SCORINGS),
                options,
            })
            .refine((value) => correctCount(value) >= 1, {
                path: ['options'],
                message: 'Mark at least one option correct',
            })
            .refine((value) => value.mcqScoring !== 'SINGLE' || correctCount(value) <= 1, {
                path: ['options'],
                message: 'A SINGLE question has exactly one correct option',
            }),
        z.strictObject({ kind: z.literal('TF'), ...extra, body, imageId: id.optional(), value: z.boolean() }),
        z.strictObject({ kind: z.literal('SHORT'), ...extra, body, imageId: id.optional(), accepted }),
        z.strictObject({ kind: z.literal('ESSAY'), ...extra, body, imageId: id.optional() }),
    ]);

const questionBody = questionUnion({ subjectId: id, gradeLevel, privateUntil });

// An edit sends the question's whole content again. Its kind is named so the shape
// can be checked, and must be the one it has; Subject and Grade Level are refused -
// duplicating is the way to another level.
const questionEdit = questionUnion({ privateUntil });

const flag = z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true');

const questionListQuery = z.object({
    subjectId: id.optional(),
    gradeLevel: gradeLevel.optional(),
    kind: z.enum(KINDS).optional(),
    mine: flag,
    // The archived ones instead: the caller's own, or every one for a leader.
    archived: flag,
});

// The copy keeps the Subject. Without a gradeLevel it keeps that too.
const duplicateBody = z.strictObject({ gradeLevel: gradeLevel.optional() }).default({});

// ---- Assessments (ticket 02) ----

// Whether the window fits the Semester, and opensAt comes first, is the service's:
// an edit may move one end only.

const TYPES = ['TUGAS', 'KUIS', 'UTS', 'UAS'];

// An instant, with its offset: '2026-10-12T07:00:00+07:00' or '...Z'.
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const title = z.string().trim().min(1, 'Give the assessment a title').max(200, 'The title is too long');

// HTML, sanitised by the service as a question's body is. Empty or null is none.
const instructions = z.string().max(20_000, 'The instructions are too long').nullable();

// An ONLINE Assessment's settings (owner, 2026-10-04; ranges 2026-10-07).
const settings = {
    maxAttempts: z.number().int().min(1).max(20),
    acceptLate: z.boolean(),
    timeLimitMinutes: z.number().int().min(1).max(600).nullable(),
    shuffleQuestions: z.boolean(),
    shuffleOptions: z.boolean(),
    showKeyOnRelease: z.boolean(),
};

const common = {
    type: z.enum(TYPES),
    title,
    instructions: instructions.optional(),
    opensAt: instant,
    closesAt: instant,
};

// An OFFLINE one has no settings, so naming one is refused rather than ignored.
const assessmentBody = z.discriminatedUnion('mode', [
    z.strictObject({
        mode: z.literal('ONLINE'),
        ...common,
        maxAttempts: settings.maxAttempts.default(1),
        acceptLate: settings.acceptLate.default(false),
        timeLimitMinutes: settings.timeLimitMinutes.optional(),
        shuffleQuestions: settings.shuffleQuestions.default(false),
        shuffleOptions: settings.shuffleOptions.default(false),
        showKeyOnRelease: settings.showKeyOnRelease.default(false),
    }),
    z.strictObject({ mode: z.literal('OFFLINE'), ...common }),
]);

// The mode never changes. Whether the type or a setting may change is the service's.
const assessmentPatch = z
    .strictObject({
        type: common.type,
        title,
        instructions,
        opensAt: instant,
        closesAt: instant,
        ...settings,
    })
    .partial()
    .refine((value) => Object.keys(value).length > 0, 'Send at least one change');

// The whole list, in its order: a copy the Assessment holds by its id, a bank
// question by its questionId. Points are whole, 1 to 100 (owner, 2026-10-07).
const points = z.number().int().min(1, 'Points are 1 to 100').max(100, 'Points are 1 to 100');

const questionItem = z.union([
    z.strictObject({ id, points: points.optional() }),
    z.strictObject({ questionId: id, points: points.optional() }),
]);

const named = (list, key) => list.map((item) => item[key]).filter(Boolean);
const distinct = (values) => new Set(values).size === values.length;

// closesAt moves in the same request when the change voids Submissions and the
// window has closed, so their Students can answer again (ticket 03).
const questionListBody = z.strictObject({
    questions: z
        .array(questionItem)
        .max(200, 'At most 200 questions')
        .refine((list) => distinct(named(list, 'id')), 'A question is named twice')
        .refine((list) => distinct(named(list, 'questionId')), 'A bank question is named twice'),
    closesAt: instant.optional(),
});

// One copy edited in place (ticket 03, owner 2026-10-08): the bank's shape, of the
// kind the copy has, with its points and, as above, a closesAt.
const questionCopyEdit = questionUnion({ points: points.optional(), closesAt: instant.optional() });

const questionParams = z.object({ id, questionId: id });

// ---- answering (ticket 03) ----

// One question's answer: an MCQ's chosen option ids, a TF's value, a SHORT's or an
// ESSAY's text; null or [] clears it. Which of the three a question takes, and a
// SHORT's shorter limit, are the service's: only it knows the kind.
const answerBody = z
    .strictObject({
        optionIds: z.array(id).max(6, 'An MCQ has at most 6 options').refine(distinct, 'An option is chosen twice'),
        value: z.boolean().nullable(),
        text: z.string().max(20_000, 'An answer is at most 20,000 characters').nullable(),
    })
    .partial()
    .refine((value) => Object.keys(value).length === 1, 'Send one answer: optionIds, value or text');

// A new window, both ends or neither: with one, the copies may go to another
// Semester (owner, 2026-10-07). Whether it fits each target's is the service's.
const copyBody = z
    .strictObject({
        classSubjectIds: z
            .array(id)
            .min(1, 'Name at least one class subject')
            .max(30, 'At most 30 class subjects at once')
            .refine(distinct, 'A class subject is named twice'),
        opensAt: instant.optional(),
        closesAt: instant.optional(),
    })
    .refine((value) => (value.opensAt === undefined) === (value.closesAt === undefined), {
        path: ['closesAt'],
        message: 'Give a new window as both opensAt and closesAt, or neither',
    });

const cancelBody = z.strictObject({
    reason: z.string().trim().min(1, 'Give a reason; the students see it').max(500, 'The reason is too long'),
});

const assessmentImageParams = z.object({ id, imageId: id });

export {
    idParams,
    imageIdParams,
    questionImageParams,
    questionBody,
    questionEdit,
    questionListQuery,
    duplicateBody,
    assessmentBody,
    assessmentPatch,
    questionListBody,
    questionCopyEdit,
    questionParams,
    copyBody,
    cancelBody,
    assessmentImageParams,
    answerBody,
};
