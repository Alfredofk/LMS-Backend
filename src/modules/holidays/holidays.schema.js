import { z } from 'zod';

// Holidays are calendar dates, 'YYYY-MM-DD', the same across Indonesia's three
// zones. A date that does not exist is refused, not rolled over: 2026-02-30 parses
// to 2 March, and 2026-13-01 to an Invalid Date whose toISOString() throws - so
// that is checked first, or a bad month would be a 500 rather than a 400.
const realDay = (value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD')
    .refine(realDay, 'That date does not exist');

const year = z.coerce.number().int().min(2020).max(2100);
const name = z.string().trim().min(3, 'Name the holiday').max(150);
const kind = z.enum(['NATIONAL', 'JOINT_LEAVE']);

const DAY = 24 * 60 * 60 * 1000;
const MAX_SCHOOL_HOLIDAY_DAYS = 90;

const idParams = z.object({ id: z.string().min(1) });

// ---- the Platform Admin's national calendar -----------------------------------

const yearQuery = z.object({ year });

const fetchBody = z.strictObject({ year });

// Added by hand: confirmed as it is written, since the admin is the one checking.
const nationalBody = z.strictObject({ date, name, kind });

// Correcting a draft before confirming it. A confirmed day is withdrawn and added
// again instead, because it may already have kept Sessions from being generated.
const draftPatch = z
    .strictObject({ date: date.optional(), name: name.optional(), kind: kind.optional() })
    .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change');

const confirmBody = z.strictObject({
    ids: z.array(z.string().min(1)).min(1, 'Pick at least one holiday').max(100),
});

// ---- a school's own ---------------------------------------------------------

// A day or a run of days; a school's term break is not a holiday but the gap
// between Semesters, so a long run is refused.
const schoolHolidayBody = z
    .strictObject({ startDate: date, endDate: date, name })
    .refine((value) => value.endDate >= value.startDate, {
        path: ['endDate'],
        message: 'The holiday must end on or after it starts',
    })
    .refine(
        (value) =>
            (new Date(value.endDate) - new Date(value.startDate)) / DAY < MAX_SCHOOL_HOLIDAY_DAYS,
        { path: ['endDate'], message: `A school holiday is at most ${MAX_SCHOOL_HOLIDAY_DAYS} days` }
    );

const jointLeaveBody = z.strictObject({ observesJointLeave: z.boolean() });

// One joint-leave day: true (off), false (in school), or null (follow the school's
// default again). Required, so an empty body is not read as "back to default".
const jointLeaveDayBody = z.strictObject({ observed: z.boolean().nullable() });

export {
    date,
    idParams,
    yearQuery,
    fetchBody,
    nationalBody,
    draftPatch,
    confirmBody,
    schoolHolidayBody,
    jointLeaveBody,
    jointLeaveDayBody,
};
