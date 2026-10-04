import { z } from 'zod';

// Ticket 07: the Principal stands up the school's time spine and its classes.
//
// Only the shape is checked here. Everything that needs the database - whether a
// grade exists at this school's type, whether a semester fits inside its year,
// whether a homeroom teacher really teaches here - is the service's.

// "2026/2027": two years, the second the first plus one. The format is
// constrained so cross-school reporting can align (schema.prisma, AcademicYear).
const label = z
    .string()
    .trim()
    .regex(/^\d{4}\/\d{4}$/, 'Use the form 2026/2027')
    .refine(
        (value) => Number(value.slice(5)) === Number(value.slice(0, 4)) + 1,
        'The second year must follow the first, as in 2026/2027'
    );

const id = z.string().min(1);

const academicYearBody = z
    .object({
        label,
        startDate: z.coerce.date(),
        endDate: z.coerce.date(),
    })
    .refine((value) => value.startDate < value.endDate, {
        path: ['endDate'],
        message: 'The year must end after it starts',
    });

const semesterBody = z
    .object({
        ordinal: z.coerce.number().int().min(1).max(2),
        startDate: z.coerce.date(),
        endDate: z.coerce.date(),
        // Consumed by ticket 08: past it, only a Principal override adds a ClassSubject.
        classSubjectRegistrationDeadline: z.coerce.date().optional(),
    })
    .refine((value) => value.startDate < value.endDate, {
        path: ['endDate'],
        message: 'The semester must end after it starts',
    });

// The homeroom teacher is named in the same action (decision #53): a class is
// never created without one, so the field is required here although the column
// is nullable.
const classBody = z.strictObject({
    academicYearId: id,
    name: z.string().trim().min(1, 'Name the class').max(50),
    gradeLevel: z.coerce.number().int().min(1).max(13),
    homeroomTeacherMembershipId: id,
});

const homeroomBody = z.strictObject({
    homeroomTeacherMembershipId: id,
});

const classListQuery = z.object({
    academicYearId: id.optional(),
});

// ---- editing (owner, 2026-09-26) ----------------------------------------------
//
// Only what is sent changes. Whether the result still holds together - a year
// that still holds its semesters, a semester still inside its year - needs the
// row as it is, so the service checks it against the merged values.

const changesSomething = (value) => Object.keys(value).length > 0;
const NOTHING_TO_CHANGE = 'Send at least one field to change';

const academicYearPatch = z
    .strictObject({
        label: label.optional(),
        startDate: z.coerce.date().optional(),
        endDate: z.coerce.date().optional(),
    })
    .refine(changesSomething, NOTHING_TO_CHANGE);

// The ordinal is what a semester is, so it never changes. A deadline sent as
// null is removed.
const semesterPatch = z
    .strictObject({
        startDate: z.coerce.date().optional(),
        endDate: z.coerce.date().optional(),
        classSubjectRegistrationDeadline: z.coerce.date().nullable().optional(),
    })
    .refine(changesSomething, NOTHING_TO_CHANGE);

// The homeroom teacher has its own route, PATCH /classes/:id/homeroom.
const classPatch = z
    .strictObject({
        name: z.string().trim().min(1, 'Name the class').max(50).optional(),
        gradeLevel: z.coerce.number().int().min(1).max(13).optional(),
    })
    .refine(changesSomething, NOTHING_TO_CHANGE);

const idParams = z.object({ id });

// ---- ticket 16: moving a student to another class -----------------------------

// The student is named by studentProfileId, as the class roster lists them. The
// reason is optional: the receiving homeroom teacher reads it before deciding.
const classMoveBody = z.strictObject({
    studentProfileId: id,
    toClassId: id,
    reason: z.string().trim().min(3, 'Say a little more').max(500, 'Reason is too long').optional(),
});

const classMoveListQuery = z.object({
    status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'CANCELLED']).optional(),
});

// ---- ticket 08: subjects and teaching assignments ---------------------------

// A local subject (muatan lokal). The code is folded to upper case, as the
// national catalog's are, and may repeat a national code (partial-indexes.sql).
const subjectBody = z.strictObject({
    code: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{2,10}$/, 'Use 2 to 10 letters or digits, as in MULOK1'),
    name: z.string().trim().min(2, 'Name the subject').max(100),
});

// The national Subjects the school uses (registration-and-membership 20). Every one
// left out is deselected, so an empty list deselects them all. Whether each id is a
// national Subject is the service's.
const subjectSelectionBody = z.strictObject({
    selectedIds: z.array(id).max(100),
});

const slot = {
    classId: id,
    subjectId: id,
    semesterId: id,
};

// A teacher taking a subject on for themselves: the caller is the teacher.
const classSubjectBody = z.strictObject(slot);

// The Principal's path past the deadline, naming the teacher.
const overrideBody = z.strictObject({ ...slot, teacherMembershipId: id });

// No default: the Principal's queue reads PENDING when nothing is asked for,
// while a teacher's own list shows everything they ever asked for.
const classSubjectListQuery = z.object({
    status: z.enum(['PENDING', 'ACTIVE', 'REJECTED', 'CANCELLED']).optional(),
    // A Vice Principal teaches too (ADR-0009): mine=true answers with their own
    // requests instead of the queue they review.
    mine: z
        .enum(['true', 'false'])
        .optional()
        .transform((value) => value === 'true'),
});

// Left loose on purpose: approval.js owns the "at least 3 characters" rule.
const rejectBody = z.object({
    reason: z.string().max(500, 'Reason is too long').optional(),
});

const bulkApproveBody = z.strictObject({
    ids: z.array(id).min(1, 'Pick at least one request').max(100),
});

// Ending or replacing an ACTIVE assignment (teaching-and-learning 10). The reason
// is required, but its "at least 3 characters" is approval.js's, as for rejectBody.
const reason = z.string().max(500, 'Reason is too long').optional();

// No default for subjectStops: whether the Sessions ahead wait for a successor or
// are cancelled is chosen every time (owner, 2026-09-29).
const endBody = z.strictObject({
    reason,
    subjectStops: z.boolean({ message: 'Say whether the subject stops (true) or a successor follows (false)' }),
});

const replaceBody = z.strictObject({ reason, teacherMembershipId: id });

export {
    academicYearBody,
    semesterBody,
    classBody,
    homeroomBody,
    classListQuery,
    academicYearPatch,
    semesterPatch,
    classPatch,
    idParams,
    classMoveBody,
    classMoveListQuery,
    subjectBody,
    subjectSelectionBody,
    classSubjectBody,
    overrideBody,
    classSubjectListQuery,
    rejectBody,
    bulkApproveBody,
    endBody,
    replaceBody,
};
