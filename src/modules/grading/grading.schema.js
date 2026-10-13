import { z } from 'zod';

// Grade settings (grading-and-report-card ticket 01). Only the shape is checked here:
// whole numbers, the four weights adding up to 100. Who may set the school's or a
// slot's, and whether the slot still takes a change, is the service's.

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

export { idParams, schoolSettingsBody, slotSettingsBody, slotClearBody };
