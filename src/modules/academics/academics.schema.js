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

const idParams = z.object({ id });

export {
    academicYearBody,
    semesterBody,
    classBody,
    homeroomBody,
    classListQuery,
    idParams,
};
