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

const listQuery = z.object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'),
});

// Left loose on purpose: approval.js owns the "a reason is required" rule, so
// the message is the same for every kind of rejection in the system.
const rejectBody = z.object({
    reason: z.string().max(500, 'Reason is too long').optional(),
});

export { registrationBody, idParams, listQuery, rejectBody };
