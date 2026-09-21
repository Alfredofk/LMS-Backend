import { z } from 'zod';

import { SCHOOL_TYPES, SCHOOL_TYPE_NAMES, isValidDurationYears } from '../../shared/schoolType.js';

/*
  The registration arrives as multipart/form-data, because the KTP rides along
  with it, so every field here starts life as a string.
*/

// An empty form field means "not given", not zero.
const blankToUndefined = (value) => (value === '' ? undefined : value);

// NPSN is 8 digits. Whether it is REAL is the platform admin's call, made by hand.
const npsn = z.string().trim().regex(/^\d{8}$/, 'NPSN must be exactly 8 digits');

/*
  Spaces and dashes are how people write phone numbers, so they are dropped
  before checking. Beyond "digits, an optional leading +, 8 to 15 of them"
  nothing is assumed: operator prefixes change, and a wrong rule here would
  refuse a real applicant.
*/
const applicantPhone = z.preprocess(
    (value) => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : value),
    z.string().regex(/^\+?\d{8,15}$/, 'Enter a valid phone number')
);

const registrationBody = z
    .object({
        npsn,
        schoolName: z.string().trim().min(3, 'School name is too short').max(150),
        schoolType: z.enum(SCHOOL_TYPE_NAMES),
        city: z.string().trim().min(2, 'City is required').max(100),
        applicantPhone,
        durationYears: z.preprocess(blankToUndefined, z.coerce.number().int().optional()),
    })
    /*
      Only an SMK chooses its length, and it must. Every other type has exactly
      one legal value (shared/schoolType.js), so it is filled in rather than asked
      for - and refused if someone sends a different one.
    */
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

/*
  The platform admin's queue, searched and filtered in the database.

  The screen used to fetch all three statuses and sift them in the browser, which
  works only while the whole platform fits in one page of memory. Every parameter
  below is optional, so the old call - `?status=PENDING` and nothing else - still
  means exactly what it meant.

  `deactivated` is an enum rather than a boolean because a query string carries
  text: `z.coerce.boolean()` reads the string "false" as true, silently.
*/
const listQuery = z
    .object({
        // ALL is for one search box across every tab at once.
        status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING'),
        /*
          One needle, five haystacks: school name, NPSN, city, and the applicant's
          name and email. Which field the admin half-remembers is not their
          problem, so it is not theirs to choose.
        */
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

/*
  Left loose on purpose: approval.js owns the "at least 3 characters" rule, so the
  message is the same everywhere a decision has to be explained.

  Three names for one shape, because the routes read better for it - and because
  a reactivation's note is genuinely optional, while the other two are not.
*/
const rejectBody = z.object({
    reason: z.string().max(500, 'Reason is too long').optional(),
});
const deactivateBody = rejectBody;
const reactivateBody = rejectBody;

export {
    registrationBody,
    idParams,
    listQuery,
    rejectBody,
    deactivateBody,
    reactivateBody,
};
