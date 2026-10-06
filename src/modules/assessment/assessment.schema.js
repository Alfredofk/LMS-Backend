import { z } from 'zod';

// The question bank (assessment ticket 01). Only the shape is checked here, a
// question's rules per kind included. Who may write for which Subject and Grade
// Level, whose images may be named, and sanitising the body are the service's.

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

// The four kinds, each with what it holds and nothing else. `extra` is what a
// new question names besides: its Subject and Grade Level, which an edit never
// changes.
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

const questionBody = questionUnion({ subjectId: id, gradeLevel });

// An edit sends the question's whole content again. Its kind is named so the shape
// can be checked, and must be the one it has; Subject and Grade Level are refused -
// duplicating is the way to another level.
const questionEdit = questionUnion({});

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

export {
    idParams,
    imageIdParams,
    questionImageParams,
    questionBody,
    questionEdit,
    questionListQuery,
    duplicateBody,
};
