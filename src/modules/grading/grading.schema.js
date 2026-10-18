import { z } from 'zod';

// Grade settings (grading-and-report-card ticket 01), and the Descriptions and Notes
// (ticket 03). Only the shape is checked here: whole numbers, the four weights adding
// up to 100, the texts' length. Who may write, for which Students, and whether the
// slot or Semester still takes a change, is the service's.

const idParams = z.object({ id: z.string().min(1) });

const REMEDIAL_RULES = ['CAP_AT_KKTP', 'HIGHEST', 'AVERAGE'];

const weight = z
    .number()
    .int('A weight is a whole number')
    .min(0, 'A weight is 0 to 100')
    .max(100, 'A weight is 0 to 100');

// The four types at once: a type left out would leave the sum to guess.
const weights = z
    .strictObject({ TUGAS: weight, KUIS: weight, UTS: weight, UAS: weight })
    .refine(
        (value) => Object.values(value).reduce((sum, share) => sum + share, 0) === 100,
        'The four weights must add up to 100'
    );

const kktp = z
    .number()
    .int('The KKTP is a whole number')
    .min(0, 'The KKTP is 0 to 100')
    .max(100, 'The KKTP is 0 to 100');

// The updatedAt the caller last read, sent back with every change (the 2026-10-09
// convention). Null, or none, while nothing was saved yet - as the read says.
const seen = {
    updatedAt: z.iso
        .datetime({ offset: true, error: 'Send back the updatedAt you last read' })
        .transform((value) => new Date(value))
        .nullable()
        .optional(),
};

const hasChange = (value) => Object.keys(value).some((key) => key !== 'updatedAt');

// The school's defaults and its remedial rule, any of them at once.
const schoolSettingsBody = z
    .strictObject({
        weights: weights.optional(),
        kktp: kktp.optional(),
        remedialRule: z.enum(REMEDIAL_RULES).optional(),
        ...seen,
    })
    .refine(hasChange, 'Send at least one change');

// A slot's own weights or KKTP; null puts that one back to the school's.
const slotSettingsBody = z
    .strictObject({
        weights: weights.nullable().optional(),
        kktp: kktp.nullable().optional(),
        ...seen,
    })
    .refine(hasChange, 'Send at least one change');

// Clearing a slot's own settings, all of them.
const slotClearBody = z.strictObject(seen);

// ---- descriptions and notes (ticket 03) ----

const noteParams = z.object({ id: z.string().min(1), semesterId: z.string().min(1) });

// Plain text, as an ESSAY's answer is (owner, 2026-10-17): no markup is read in it.
const words = z.string().trim().max(1_000, 'At most 1,000 characters');

// The updatedAt each row read, or null where it read none - named on every row, so a
// form that forgets it is refused rather than taken for a first write.
const readAt = z.iso
    .datetime({ offset: true, error: 'Send back the updatedAt you last read, or null' })
    .transform((value) => new Date(value))
    .nullable();

// Many Students in one request (owner, 2026-10-17), each named once.
const textRows = (text, label) =>
    z
        .array(z.strictObject({ studentProfileId: z.string().min(1), text, updatedAt: readAt }))
        .min(1, `Send at least one ${label}`)
        .max(200, `At most 200 ${label}s at once`)
        .refine(
            (rows) => new Set(rows.map((row) => row.studentProfileId)).size === rows.length,
            'A student is named twice'
        );

// A Description is required, so it is never emptied.
const descriptionsBody = z.strictObject({
    descriptions: textRows(words.min(1, 'Write the description; it cannot be empty'), 'description'),
});

// A Note is optional: null or an empty text clears it.
const notesBody = z.strictObject({
    notes: textRows(words.nullable().transform((value) => value || null), 'note'),
});

export { idParams, schoolSettingsBody, slotSettingsBody, slotClearBody, noteParams, descriptionsBody, notesBody };
