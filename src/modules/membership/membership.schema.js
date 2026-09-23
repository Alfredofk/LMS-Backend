import { z } from 'zod';

// Join by School Code (ticket 05, ADR-0002).
//
// Everything here arrives as JSON, unlike the school registration, which is
// multipart because a KTP rides along with it.
//
// PRINCIPAL is deliberately absent from the requestable roles. The first
// Principal is created by the platform admin who approves the school
// registration, and nobody else could have approved them (ticket 04). A second
// Principal is a later feature, not something a stranger asks for.
const REQUESTABLE_ROLES = ['TEACHER', 'STUDENT', 'GUARDIAN'];

// Eight characters from the School Code alphabet (school.service.js drops 0/O
// and 1/I, because the code is read aloud and typed from a WhatsApp message).
// Lowercase is accepted and folded up: people type what they see.
//
// A code that fails this check never reaches the database, and the 400 it earns
// costs the caller the same joinSchoolLimiter budget a wrong-but-well-formed code
// would - guessing is meant to be expensive either way.
const schoolCode = z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z2-9]{8}$/, 'A School Code is 8 letters and digits');

// National identifier formats. These are the owner's rules, visible here to be
// overturned rather than buried in a regex:
//
// - NISN is the 10-digit national student number.
// - NUPTK is 16 digits.
// - NIP runs 9 to 18 digits: the post-2009 format is 18, but a teacher appointed
//   before that still carries a 9-digit NIP lama, and refusing them would be
//   refusing a real applicant.
//
// A teacher may hold either, or both, so neither is required on its own - the
// refinement below asks for at least one.
const nisn = z.string().trim().regex(/^\d{10}$/, 'NISN is 10 digits');
const nip = z.string().trim().regex(/^\d{9,18}$/, 'NIP is 9 to 18 digits');
const nuptk = z.string().trim().regex(/^\d{16}$/, 'NUPTK is 16 digits');

const fullName = z.string().trim().min(3, 'Enter the full name').max(150);

const lookupBody = z.object({ schoolCode });

// strictObject, not object: zod strips unknown keys by default, and a student
// sending a classId would then be silently ignored rather than told that the class
// is not theirs to choose. Refusing is the honest answer.
const teacherPayload = z
    .strictObject({ nip: nip.optional(), nuptk: nuptk.optional() })
    .refine((value) => Boolean(value.nip || value.nuptk), {
        message: 'Give a NIP or a NUPTK',
        path: ['nip'],
    });

// No classId. The applicant asks for a grade; the homeroom teacher chooses the
// class when they release the request (owner's decision, 2026-09-20). That is
// what keeps a leaked School Code from exposing a class list, and it lets a
// school take student requests before it has created any class at all.
//
// The grade itself is checked against the school's type in the service, where the
// school is known - grade 7 is not a thing at an SD (shared/schoolType.js). The
// ceiling here is 13, not 12, because a four-year SMK runs to 13; anything tighter
// belongs to isValidGrade, which knows the school.
const studentPayload = z.strictObject({
    nisn,
    birthDate: z.coerce.date(),
    gradeLevel: z.coerce.number().int().min(1).max(13),
});

// The child is named, never listed. The applicant must already know both the
// NISN and the name, which is the whole out-of-band check ADR-0002 relies on.
const guardianPayload = z.strictObject({
    childNisn: nisn,
    childFullName: fullName,
    relationship: z.string().trim().min(3, 'State the relationship').max(50),
});

// Every requested role must bring its payload, and a payload for a role that was
// not requested is refused rather than ignored - the same strictness ticket 04
// applies to an SMA that sends a duration it may not choose.
//
// The STUDENT-is-exclusive rule is NOT here. It lives in
// shared/approval.js assertRoleCombinationAllowed(), because the approval service
// has to enforce it a second time when a role is released.
function requirePayloadPerRole(payloads) {
    return (value, ctx) => {
        const requested = new Set(value.roles);

        for (const [role, key] of Object.entries(payloads)) {
            if (requested.has(role) && value[key] === undefined) {
                ctx.addIssue({
                    code: 'custom',
                    path: [key],
                    message: `The ${role} role needs its ${key} details`,
                });
            }
            if (!requested.has(role) && value[key] !== undefined) {
                ctx.addIssue({
                    code: 'custom',
                    path: [key],
                    message: `You did not ask for the ${role} role`,
                });
            }
        }
    };
}

const requestBody = z
    .object({
        schoolCode,
        roles: z.array(z.enum(REQUESTABLE_ROLES)).min(1, 'Pick at least one role').max(3),
        teacher: teacherPayload.optional(),
        student: studentPayload.optional(),
        guardian: guardianPayload.optional(),
    })
    .superRefine(
        requirePayloadPerRole({ TEACHER: 'teacher', STUDENT: 'student', GUARDIAN: 'guardian' })
    );

// Adding a role to a membership that is already ACTIVE (owner, 2026-09-22): a
// Principal who also teaches, a teacher whose child has just enrolled.
//
// STUDENT is not on offer. It cannot join any other role, and a member who holds
// none but wants to become a student is somebody who should have joined as one.
// No schoolCode either - the school is the one the caller's token already names.
const ADDABLE_ROLES = ['TEACHER', 'GUARDIAN'];

const addRolesBody = z
    .strictObject({
        roles: z.array(z.enum(ADDABLE_ROLES)).min(1, 'Pick at least one role').max(2),
        teacher: teacherPayload.optional(),
        guardian: guardianPayload.optional(),
    })
    .superRefine(requirePayloadPerRole({ TEACHER: 'teacher', GUARDIAN: 'guardian' }));

// A further child, claimed by a member whose GUARDIAN role is already ACTIVE: the
// same three fields a GUARDIAN join request carries, and nothing else.
const addChildBody = guardianPayload;

const idParams = z.object({ id: z.string().min(1) });

// Only the roles /me/roles can add can be waiting on an ACTIVE membership.
const roleParams = z.object({ role: z.enum(ADDABLE_ROLES) });

const linkParams = z.object({ linkId: z.string().min(1) });

const listQuery = z.object({
    status: z.enum(['PENDING', 'ACTIVE', 'REJECTED']).default('PENDING'),
});

// classId is required only when a STUDENT role is being released, and the service
// is what knows that - it must also check the class is one the reviewer is
// homeroom of. Optional here so a TEACHER approval needs no body at all.
const approveBody = z
    .object({ classId: z.string().min(1).optional() })
    .default({});

// approval.js owns "a reason is required", so every rejection in the system
// refuses with the same message.
const rejectBody = z.object({
    reason: z.string().max(500, 'Reason is too long').optional(),
});

const bulkApproveBody = z.object({
    ids: z.array(z.string().min(1)).min(1, 'Pick at least one request').max(50),
    classId: z.string().min(1).optional(),
});

export {
    REQUESTABLE_ROLES,
    lookupBody,
    requestBody,
    addRolesBody,
    addChildBody,
    idParams,
    roleParams,
    linkParams,
    listQuery,
    approveBody,
    rejectBody,
    bulkApproveBody,
};
