import { z } from 'zod';

import { SCHOOL_TYPES, SCHOOL_TYPE_NAMES, isValidDurationYears } from '../../shared/schoolType.js';
import { TIME_ZONES } from '../../shared/timeZone.js';

// The registration arrives as multipart/form-data, because the KTP rides along
// with it, so every field here starts life as a string.

// An empty form field means "not given", not zero.
const blankToUndefined = (value) => (value === '' ? undefined : value);

// NPSN is 8 digits. Whether it is REAL is the platform admin's call, made by hand.
const npsn = z.string().trim().regex(/^\d{8}$/, 'NPSN must be exactly 8 digits');

// Spaces and dashes are how people write phone numbers, so they are dropped
// before checking. Beyond "digits, an optional leading +, 8 to 15 of them"
// nothing is assumed: operator prefixes change, and a wrong rule here would
// refuse a real applicant.
const applicantPhone = z.preprocess(
    (value) => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : value),
    z.string().regex(/^\+?\d{8,15}$/, 'Enter a valid phone number')
);

// The school's point, for a student's check-in (teaching-and-learning ticket 01).
// Checked against Indonesia's extent rather than the whole globe: a point in the
// sea off Africa is a typo - swapped fields, a dropped minus sign - not a school.
// Roughly 6°N to 11°S and 95°E to 141°E. Coerced, because the registration is
// multipart and every field arrives as a string - but a blank field, or a JSON
// null, is "not given", not zero: coerced as they stand, '' and null become 0,
// which is on the equator and inside the box.
const coordinate = (name, min, max) =>
    z.preprocess(
        (value) => (value === '' || value === null ? undefined : value),
        z.coerce
            .number(`${name} must be a number`)
            .min(min, 'The point must be in Indonesia')
            .max(max, 'The point must be in Indonesia')
    );
const latitude = coordinate('Latitude', -11, 6);
const longitude = coordinate('Longitude', 95, 141);

// The zone the school's timetable is written in (teaching-and-learning ticket 07).
// Chosen, never guessed from the point: the WIB/WITA line follows provinces, not
// a meridian (West and Central Kalimantan are WIB, South and East are WITA).
const timeZone = z.enum(TIME_ZONES, 'Choose WIB, WITA or WIT');

const registrationBody = z
    .object({
        npsn,
        schoolName: z.string().trim().min(3, 'School name is too short').max(150),
        schoolType: z.enum(SCHOOL_TYPE_NAMES),
        city: z.string().trim().min(2, 'City is required').max(100),
        latitude,
        longitude,
        timeZone,
        applicantPhone,
        durationYears: z.preprocess(blankToUndefined, z.coerce.number().int().optional()),
    })
    // Only an SMK chooses its length, and it must. Every other type has exactly
    // one legal value (shared/schoolType.js), so it is filled in rather than asked
    // for - and refused if someone sends a different one.
    .superRefine((value, ctx) => {
        const { schoolType, durationYears } = value;

        if (schoolType === 'SMK' && durationYears === undefined) {
            ctx.addIssue({
                code: 'custom',
                path: ['durationYears'],
                message: 'An SMK must state its duration: 3 or 4 years',
            });
            return;
        }

        if (durationYears !== undefined && !isValidDurationYears(schoolType, durationYears)) {
            ctx.addIssue({
                code: 'custom',
                path: ['durationYears'],
                message:
                    schoolType === 'SMK'
                        ? 'An SMK runs 3 or 4 years'
                        : `A ${schoolType} runs ${SCHOOL_TYPES[schoolType].defaultDurationYears} years`,
            });
        }
    })
    .transform((value) => ({
        ...value,
        durationYears: value.durationYears ?? SCHOOL_TYPES[value.schoolType].defaultDurationYears,
    }));

const idParams = z.object({ id: z.string().min(1) });

// The platform admin's queue, searched and filtered in the database.
//
// The screen used to fetch all three statuses and sift them in the browser, which
// works only while the whole platform fits in one page of memory. Every parameter
// below is optional, so the old call - `?status=PENDING` and nothing else - still
// means exactly what it meant.
//
// `deactivated` is an enum rather than a boolean because a query string carries
// text: `z.coerce.boolean()` reads the string "false" as true, silently.
const listQuery = z
    .object({
        // ALL is for one search box across every tab at once.
        status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING'),
        // One needle, five haystacks: school name, NPSN, city, and the applicant's
        // name and email. Which field the admin half-remembers is not their
        // problem, so it is not theirs to choose.
        q: z.string().trim().min(1).max(100).optional(),
        schoolType: z.enum(SCHOOL_TYPE_NAMES).optional(),
        city: z.string().trim().min(1).max(100).optional(),
        // Only an approved registration has a school, so this implies APPROVED.
        deactivated: z
            .enum(['true', 'false'])
            .optional()
            .transform((value) => (value === undefined ? undefined : value === 'true')),
        submittedFrom: z.coerce.date().optional(),
        submittedTo: z.coerce.date().optional(),
        // A queue is worked from the front; a decided list reads better newest first.
        sort: z.enum(['oldest', 'newest']).default('oldest'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
    })
    .superRefine((value, ctx) => {
        const { submittedFrom, submittedTo } = value;
        if (submittedFrom && submittedTo && submittedFrom > submittedTo) {
            ctx.addIssue({
                code: 'custom',
                path: ['submittedTo'],
                message: 'The end of the range cannot be before its start',
            });
        }
    });

// Left loose on purpose: approval.js owns the "at least 3 characters" rule, so the
// message is the same everywhere a decision has to be explained.
//
// Three names for one shape, because the routes read better for it - and because
// a reactivation's note is genuinely optional, while the other two are not.
const rejectBody = z.object({
    reason: z.string().max(500, 'Reason is too long').optional(),
});
const deactivateBody = rejectBody;
const reactivateBody = rejectBody;

// The Principal correcting the school's point, within the same extent as at
// registration. Both fields, always: half a point is not a place.
const locationBody = z.strictObject({ latitude, longitude });

// The Principal changing the zone - refused once the school has Sessions (the
// service's rule, from ticket 02 on).
const timeZoneBody = z.strictObject({ timeZone });

// A Platform Admin appointing a school's Principal when the one before cannot hand
// it over (owner, 2026-09-27). The admin sees no member list, so the successor is
// named by the email of an active teacher there. Always with a reason, audited.
const appointPrincipalBody = z.strictObject({
    email: z
        .email('Enter a valid email address')
        .max(254)
        .transform((value) => value.trim().toLowerCase()),
    reason: z.string().trim().min(3, 'A reason is required').max(500, 'Reason is too long'),
});

export {
    registrationBody,
    idParams,
    listQuery,
    rejectBody,
    deactivateBody,
    reactivateBody,
    appointPrincipalBody,
    locationBody,
    timeZoneBody,
};
