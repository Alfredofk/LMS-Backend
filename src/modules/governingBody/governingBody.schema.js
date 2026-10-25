import { z } from 'zod';

import { phone } from '../auth/auth.schema.js';
import { schoolCode } from '../membership/membership.schema.js';
import { schoolFields, schoolRow } from '../school/school.schema.js';

// Governing Bodies (governing-body ticket 03). A registration arrives as
// multipart/form-data, because the KTP and the proof ride along with it, so every
// field here starts life as a string.

const KINDS = ['FOUNDATION', 'ASSOCIATION', 'GOVERNMENT'];

// An empty form field means "not given".
const blankToUndefined = (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const text = (label, max) =>
    z.string().trim().min(2, `${label} is too short`).max(max, `${label} is too long`);

// The Kemenkumham SK, written as it is on the letter ("AHU-0012345.AH.01.04.Tahun 2015"):
// compared trimmed, in capitals, with its spaces collapsed, so one number is one number.
const skNumber = z
    .string()
    .trim()
    .min(5, 'The SK number is too short')
    .max(100, 'The SK number is too long')
    .transform((value) => value.replace(/\s+/g, ' ').toUpperCase());

// The NPYP, the Nomor Pokok Yayasan Pendidikan: Dapodik's number for an education yayasan,
// six letters and digits (governing-body ticket 04b, owner 2026-10-24). Compared trimmed
// and in capitals; a space inside it is refused rather than dropped.
const npyp = z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6}$/, 'An NPYP is six letters and digits');

// The full address (K5): every part required but the postal code (owner, 2026-10-22).
const address = {
    street: text('The street', 200),
    village: text('The kelurahan or desa', 100),
    district: text('The kecamatan', 100),
    city: text('The kota or kabupaten', 100),
    province: text('The province', 100),
    postalCode: z.preprocess(
        blankToUndefined,
        z.string().trim().regex(/^\d{5}$/, 'A postal code is five digits').optional()
    ),
};

// A FOUNDATION or an ASSOCIATION is an education yayasan in Dapodik, so it has an NPYP; its
// Kemenkumham SK number is optional, since downloading the SK costs money (ticket 04b,
// owner 2026-10-24). A GOVERNMENT body is the state itself and has neither, which is
// refused rather than kept.
function checkNumbers(value, ctx) {
    if (value.kind !== 'GOVERNMENT') {
        if (!value.npyp) {
            ctx.addIssue({ code: 'custom', path: ['npyp'], message: 'A foundation or an association gives its NPYP' });
        }
        return;
    }
    if (value.npyp) {
        ctx.addIssue({ code: 'custom', path: ['npyp'], message: 'A government body has no NPYP' });
    }
    if (value.skNumber) {
        ctx.addIssue({ code: 'custom', path: ['skNumber'], message: 'A government body has no Kemenkumham SK number' });
    }
}

const registrationBody = z
    .strictObject({
        kind: z.enum(KINDS),
        name: text('The name', 150),
        npyp: z.preprocess(blankToUndefined, npyp.optional()),
        skNumber: z.preprocess(blankToUndefined, skNumber.optional()),
        ...address,
        applicantPhone: phone,
    })
    .superRefine(checkNumbers);

const idParams = z.object({ id: z.string().min(1) });

// A body and one of its seats, for the Platform Admin's decision on a body left with no
// admin (ticket 04).
const seatParams = z.object({ id: z.string().min(1), seatId: z.string().min(1) });

// ---- the Governing Body Code (ticket 04) ----

// The School Code's shape, typed from a WhatsApp message: trimmed, in capitals.
const code = z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z2-9]{8}$/, 'A Governing Body Code is 8 letters and digits');

// The lookup and an admin application send the code alone. A Principal applies through the
// School's own code instead (ticket 06, owner 2026-10-24), below.
const codeBody = z.strictObject({ code });

// ---- Principal applications (ticket 06) ----

// Multipart, beside the KTP: the School Code the body handed out, and the applicant's phone,
// named as both registrations name theirs.
const principalApplicationBody = z.strictObject({ schoolCode, applicantPhone: phone });

// A School's applications for its body's admins: the waiting ones unless asked otherwise.
const principalApplicationsQuery = z.object({
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'ALL']).default('PENDING'),
});

// ---- its reads (ticket 07) ----

// A School's Students, a page at a time: one Class's, or found by a part of the name or
// NISN (owner, 2026-10-26), paged as the Platform Admin's list of Schools is.
const studentsQuery = z.object({
    q: z.string().trim().min(1).max(100).optional(),
    classId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});

// A removal's reason is required and shown to the admin removed (K6).
const removeBody = z.strictObject({
    reason: z.string().trim().min(3, 'Give the reason').max(500, 'Reason is too long'),
});

// ---- its powers over its Schools (ticket 08) ----

// Ending the Principal's role, deactivating, releasing: a reason, required, as a removal's.
const reasonBody = removeBody;

// A Teacher made Principal, named by the membershipId the teacher list gives (ticket 07).
const appointBody = z.strictObject({
    membershipId: z.string().min(1),
    reason: z.string().trim().min(3, 'Give the reason').max(500, 'Reason is too long'),
});

// An admin's change of the body's address and phone (the spec's defaults). The name,
// the kind, the NPYP and the SK number are the Platform Admin's, so a key for them is
// refused rather than ignored. The postal code and the phone clear to null.
const profileBody = z
    .strictObject({
        street: address.street.optional(),
        village: address.village.optional(),
        district: address.district.optional(),
        city: address.city.optional(),
        province: address.province.optional(),
        postalCode: z.string().trim().regex(/^\d{5}$/, 'A postal code is five digits').nullable().optional(),
        phone: phone.nullable().optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, {
        message: 'Change at least one part of the address or the phone',
    });

// The Platform Admin's queue, filtered in the database, as the School queue's is.
const listQuery = z
    .object({
        status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ALL']).default('PENDING'),
        // One needle over the name, the NPYP (the registration's or its body's), the SK
        // number, the city, and the applicant's name and email.
        q: z.string().trim().min(1).max(100).optional(),
        kind: z.enum(KINDS).optional(),
        // Only an approved registration has a body, so this implies APPROVED.
        deactivated: z
            .enum(['true', 'false'])
            .optional()
            .transform((value) => (value === undefined ? undefined : value === 'true')),
        submittedFrom: z.coerce.date().optional(),
        submittedTo: z.coerce.date().optional(),
        sort: z.enum(['oldest', 'newest']).default('oldest'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
    })
    .superRefine((value, ctx) => {
        if (value.submittedFrom && value.submittedTo && value.submittedFrom > value.submittedTo) {
            const message = 'The end of the range cannot be before its start';
            ctx.addIssue({ code: 'custom', path: ['submittedTo'], message });
        }
    });

// approval.js says whether a reason is required, so every refusal reads the same.
const decisionBody = z
    .strictObject({
        reason: z.string().max(500, 'Reason is too long').optional(),
    })
    .default({});

// ---- its Schools (ticket 05) ----

// One submission creates at most this many Schools, all or none (K7).
const MAX_SCHOOLS_AT_ONCE = 10;

// The Schools a body creates at once, each row a School Registration's fields without
// the phone and the KTP. Two rows naming one NPSN are refused here, naming both; one a
// School holds or a registration waits on is the service's to find.
const createSchoolsBody = z
    .strictObject({
        schools: z
            .array(schoolRow)
            .min(1, 'Send at least one school')
            .max(MAX_SCHOOLS_AT_ONCE, `At most ${MAX_SCHOOLS_AT_ONCE} schools in one submission`),
    })
    .superRefine(({ schools }, ctx) => {
        // Zod may run this over a body whose list failed its own shape.
        if (!Array.isArray(schools)) return;
        const firstRowOf = new Map();
        schools.forEach((row, index) => {
            const first = firstRowOf.get(row.npsn);
            if (first === undefined) {
                firstRowOf.set(row.npsn, index);
                return;
            }
            const message = `Row ${index + 1} repeats the NPSN of row ${first + 1}`;
            ctx.addIssue({ code: 'custom', path: ['schools', index, 'npsn'], message });
        });
    });

// A fix of one of its Schools while it has never had a Principal (K10): the name, the NPSN, the
// type and an SMK's duration, each by the registration's rule. Whether the type and the
// duration then agree is the service's to check, against what the School holds.
const schoolPatchBody = z
    .strictObject({
        schoolName: schoolFields.schoolName.optional(),
        npsn: schoolFields.npsn.optional(),
        schoolType: schoolFields.schoolType.optional(),
        durationYears: schoolFields.durationYears,
    })
    .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
        message: 'Change at least one of schoolName, npsn, schoolType or durationYears',
    });

// A Platform Admin's correction of a body's name, kind, NPYP or SK number. Whether the
// kind and the numbers then agree is the service's to check, against what the body holds.
const editBody = z
    .strictObject({
        name: text('The name', 150).optional(),
        kind: z.enum(KINDS).optional(),
        npyp: npyp.nullable().optional(),
        skNumber: skNumber.nullable().optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, {
        message: 'Change at least one of name, kind, npyp or skNumber',
    });

export {
    KINDS,
    registrationBody,
    idParams,
    seatParams,
    codeBody,
    principalApplicationBody,
    principalApplicationsQuery,
    studentsQuery,
    removeBody,
    reasonBody,
    appointBody,
    profileBody,
    listQuery,
    decisionBody,
    editBody,
    createSchoolsBody,
    schoolPatchBody,
};
