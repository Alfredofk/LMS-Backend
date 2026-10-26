import { z } from 'zod';

// The dashboards take one body: the School's Support Signal thresholds (dashboard ticket
// 02). Only the shape is checked here: whole numbers within their bounds (owner,
// 2026-10-27), null putting one back to the built-in value. Who may set them is the
// service's.

// ---- signal settings ----

const threshold = (what, min, max) =>
    z
        .number()
        .int(`${what} is a whole number`)
        .min(min, `${what} is ${min} to ${max}`)
        .max(max, `${what} is ${min} to ${max}`)
        .nullable()
        .optional();

const signalSettingsBody = z
    .strictObject({
        absenceCount: threshold('The absence count', 1, 30),
        absenceWindowDays: threshold('The absence window', 1, 60),
        contentBehindPercent: threshold('The content behind percentage', 1, 100),
        contentBehindMinPublished: threshold('The Content published before content behind counts', 1, 50),
        notSubmittedCount: threshold('The not submitted count', 1, 20),
        inactiveDays: threshold('The inactive days', 1, 60),
        // The updatedAt the caller last read (the 2026-10-09 convention). Null, or none,
        // while nothing was saved yet - as the read says.
        updatedAt: z.iso
            .datetime({ offset: true, error: 'Send back the updatedAt you last read' })
            .transform((value) => new Date(value))
            .nullable()
            .optional(),
    })
    .refine((value) => Object.keys(value).some((key) => key !== 'updatedAt'), 'Send at least one change');

export { signalSettingsBody };
