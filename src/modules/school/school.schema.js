import { z } from 'zod';

import { SCHOOL_TYPES, SCHOOL_TYPE_NAMES, isValidDurationYears } from '../../shared/schoolType.js';
import { TIME_ZONES } from '../../shared/timeZone.js';
import { MAX_SUBDOMAIN_LENGTH, SUBDOMAIN_PATTERN } from '../../shared/subdomain.js';
import { phone } from '../auth/auth.schema.js';

// The registration arrives as multipart/form-data, because the KTP rides along
// with it, so every field here starts life as a string.

// An empty form field means "not given", not zero.
const blankToUndefined = (value) => (value === '' ? undefined : value);

// NPSN is 8 digits. Whether it is REAL is the platform admin's call, made by hand.
const npsn = z.string().trim().regex(/^\d{8}$/, 'NPSN must be exactly 8 digits');

// The founder's number, checked by the one rule every phone number here follows
// (auth.schema.js).
const applicantPhone = phone;

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

// A School's own fields, as its founder registers them and as a Governing Body creates
// one (governing-body ticket 05, K7): one shape, so the two never drift apart.
const schoolFields = {
    npsn,
    schoolName: z.string().trim().min(3, 'School name is too short').max(150),
    schoolType: z.enum(SCHOOL_TYPE_NAMES),
    city: z.string().trim().min(2, 'City is required').max(100),
    latitude,
    longitude,
    timeZone,
    durationYears: z.preprocess(blankToUndefined, z.coerce.number().int().optional()),
};

// Only an SMK chooses its length, and it must. Every other type has exactly one legal
// value (shared/schoolType.js), so it is filled in rather than asked for - and refused
// if someone sends a different one.
function checkDuration(value, ctx) {
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
}

const withDuration = (value) => ({
    ...value,
    durationYears: value.durationYears ?? SCHOOL_TYPES[value.schoolType].defaultDurationYears,
});

const registrationBody = z
    .object({ ...schoolFields, applicantPhone })
    .superRefine(checkDuration)
    .transform(withDuration);

// One School a Governing Body creates (governing-body ticket 05): the registration's
// fields and rules, without the phone and the KTP. It arrives as JSON, so a stray key
// is refused rather than ignored.
const schoolRow = z.strictObject(schoolFields).superRefine(checkDuration).transform(withDuration);

const idParams = z.object({ id: z.string().min(1) });

// A yes-or-no filter, written as text because a query string carries text:
// `z.coerce.boolean()` reads the string "false" as true, silently.
const trueOrFalse = z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true'));

// The platform admin's queue, searched and filtered in the database.
//
// The screen used to fetch all three statuses and sift them in the browser, which
// works only while the whole platform fits in one page of memory. Every parameter
// below is optional, so the old call - `?status=PENDING` and nothing else - still
// means exactly what it meant.
//
// `deactivated` is an enum rather than a boolean (trueOrFalse, above).
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
        deactivated: trueOrFalse,
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

// The Platform Admin's list of every School (governing-body ticket 05, owner
// 2026-10-24): independent ones and a Governing Body's alike, since a body's School has
// no registration to reach it through the queue.
const schoolListQuery = z.object({
    // One needle over the name, NPSN, city and subdomain.
    q: z.string().trim().min(1).max(100).optional(),
    // One Governing Body's Schools; `governed` false is the independent ones.
    governingBodyId: z.string().min(1).optional(),
    governed: trueOrFalse,
    deactivated: trueOrFalse,
    sort: z.enum(['name', 'newest', 'oldest']).default('name'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
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

// The letterhead's text (grading-and-report-card 10): free text, an address of at most
// 300 characters and a phone of at most 30, which may carry an area code and an
// extension. Null or empty clears one; one left out stays.
const letterheadText = (max) =>
    z
        .string()
        .trim()
        .max(max, `At most ${max} characters`)
        .nullable()
        .optional()
        .transform((value) => (value === '' ? null : value));

const letterheadBody = z
    .strictObject({ address: letterheadText(300), phone: letterheadText(30) })
    .refine((value) => value.address !== undefined || value.phone !== undefined, 'Send the address, the phone or both');

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

// ---- subdomains (governing-body ticket 02) ---------------------------------

// A host's label is not case-sensitive, so it is read in lowercase. Whether one is
// known is the service's to say, with the same 404 for every miss.
const subdomainParams = z.object({
    subdomain: z.string().trim().toLowerCase().min(1).max(MAX_SUBDOMAIN_LENGTH),
});

// A subdomain a Platform Admin sets by hand: a DNS label. Whether it is reserved or
// taken is the service's.
const subdomainBody = z.strictObject({
    subdomain: z
        .string()
        .trim()
        .toLowerCase()
        .regex(
            SUBDOMAIN_PATTERN,
            'Use 1 to 63 lowercase letters, digits or hyphens, not starting or ending with a hyphen'
        ),
});

export {
    schoolFields,
    registrationBody,
    schoolRow,
    idParams,
    listQuery,
    schoolListQuery,
    rejectBody,
    deactivateBody,
    reactivateBody,
    appointPrincipalBody,
    locationBody,
    timeZoneBody,
    letterheadBody,
    subdomainParams,
    subdomainBody,
};
