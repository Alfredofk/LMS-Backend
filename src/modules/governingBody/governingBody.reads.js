import { prisma } from '../../shared/prisma.js';
import { runInSchool } from '../../shared/tenantContext.js';
import { toDay } from '../holidays/holidays.calendar.js';
import { todayOf } from '../sessions/sessions.service.js';
import { loadOwnSchool } from './governingBody.schools.js';

// What a Governing Body's admins read of a School's people (governing-body ticket 07, the
// spec's K4): its Teachers and its Students, identity and structure, read only. Its
// dashboard figures are on the School's own row (governingBody.schools.js).
//
// Owner's decisions (2026-10-18; the plan, 2026-10-26, through the picker):
// - Teachers: name, NIP / NUPTK, the staff roles they hold, the ClassSubjects they teach
//   in the current Semester and the Classes they are Homeroom Teacher of in the current
//   year. Each carries its membershipId: ticket 08 makes a Principal from this list, with
//   no email typed.
// - The current year and Semester (owner's pick): several years may be ACTIVE at once
//   (academics, owner 2026-09-23). So the year is the latest ACTIVE one begun by the
//   School's today, else its earliest. The Semester is that year's latest begun, else its
//   first, as a Student's menu opens (assessment 07). The answer names both.
// - Students: name, NISN and the Class they sit in now, a page at a time, kept to one
//   Class or found by a part of the name or NISN (owner's pick).
// - Never: grades, Scores, attendance, Report Cards, birth dates, emails, phones,
//   Guardians. Those wait for the dashboard spec. A Teacher's own GUARDIAN role is left
//   out of their roles for the same reason.
// - Every read runs in the School's own scope once the School is found to be the body's:
//   another body's is 404. An account with no seat is refused by the guard with 403,
//   before any School is looked at (owner's pick; the Done when amended).
// - A deactivated School still reads.

// The roles a Teacher's row shows: the staff ones.
const STAFF_ROLES = ['PRINCIPAL', 'VICE_PRINCIPAL', 'TEACHER'];

const studentSelect = {
    id: true,
    user: { select: { fullName: true } },
    studentProfile: {
        select: {
            nisn: true,
            // The open placement, as currentPlacement reads it (guards.js).
            classMemberships: {
                where: { endedAt: null },
                select: { class: { select: { id: true, name: true, gradeLevel: true } } },
                take: 1,
            },
        },
    },
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const termView = ({ year, semester }) => ({
    academicYear: year ? { id: year.id, label: year.label } : null,
    semester: semester ? { id: semester.id, ordinal: semester.ordinal } : null,
});

const teacherView = (teacher, taught, homerooms) => ({
    membershipId: teacher.id,
    fullName: teacher.user.fullName,
    nip: teacher.teacherProfile?.nip ?? null,
    nuptk: teacher.teacherProfile?.nuptk ?? null,
    roles: teacher.roles.map((entry) => entry.role),
    classSubjects: taught
        .filter((row) => row.teacherMembershipId === teacher.id)
        .map((row) => ({ id: row.id, subject: row.subject, class: row.class })),
    homeroomOf: homerooms
        .filter((row) => row.homeroomTeacherMembershipId === teacher.id)
        .map((row) => ({ id: row.id, name: row.name })),
});

const studentView = (student) => ({
    membershipId: student.id,
    fullName: student.user.fullName,
    nisn: student.studentProfile?.nisn ?? null,
    class: student.studentProfile?.classMemberships[0]?.class ?? null,
});

// ---------------------------------------------------------------------------
// The current year and Semester
// ---------------------------------------------------------------------------

// Of rows ordered by their start, the latest begun by today, else the first.
const latestBegun = (rows, today) => rows.filter((row) => toDay(row.startDate) <= today).at(-1) ?? rows[0] ?? null;

// The School's current year and Semester, read in its scope. Either may be null: a
// School with no ACTIVE year, or a year with no Semester yet.
async function currentTermOf(school) {
    const [today, years] = await Promise.all([
        todayOf(school.id),
        prisma.academicYear.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true, label: true, startDate: true },
            orderBy: { startDate: 'asc' },
        }),
    ]);
    const year = latestBegun(years, today);
    if (!year) return { year: null, semester: null };

    const semesters = await prisma.semester.findMany({
        where: { academicYearId: year.id },
        select: { id: true, ordinal: true, startDate: true },
        orderBy: { startDate: 'asc' },
    });
    return { year, semester: latestBegun(semesters, today) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// GET /api/governing-body/schools/:id/teachers, for any admin: every ACTIVE member holding
// an ACTIVE TEACHER role, by name - the Principal and a Vice Principal too when they
// teach - with the live ClassSubjects they answer for this Semester and the Classes they
// are Homeroom Teacher of this year. Not paged: a School has tens of Teachers.
async function listTeachers(auth, schoolId) {
    const school = await loadOwnSchool(auth, schoolId);

    return runInSchool(school.id, school.name, async () => {
        const term = await currentTermOf(school);
        const teachers = await prisma.schoolMembership.findMany({
            where: { status: 'ACTIVE', roles: { some: { role: 'TEACHER', status: 'ACTIVE' } } },
            select: {
                id: true,
                user: { select: { fullName: true } },
                teacherProfile: { select: { nip: true, nuptk: true } },
                roles: {
                    where: { status: 'ACTIVE', role: { in: STAFF_ROLES } },
                    select: { role: true },
                    orderBy: { role: 'asc' },
                },
            },
            orderBy: [{ user: { fullName: 'asc' } }, { id: 'asc' }],
        });
        const ids = teachers.map((teacher) => teacher.id);

        const [taught, homerooms] = await Promise.all([
            term.semester
                ? prisma.classSubject.findMany({
                    where: {
                        semesterId: term.semester.id,
                        teacherMembershipId: { in: ids },
                        status: 'ACTIVE',
                        endedAt: null,
                    },
                    select: {
                        id: true,
                        teacherMembershipId: true,
                        subject: { select: { id: true, code: true, name: true } },
                        class: { select: { id: true, name: true } },
                    },
                    orderBy: [{ class: { name: 'asc' } }, { subject: { name: 'asc' } }],
                })
                : [],
            term.year
                ? prisma.class.findMany({
                    where: { academicYearId: term.year.id, homeroomTeacherMembershipId: { in: ids } },
                    select: { id: true, name: true, homeroomTeacherMembershipId: true },
                    orderBy: { name: 'asc' },
                })
                : [],
        ]);

        return {
            ...termView(term),
            teachers: teachers.map((teacher) => teacherView(teacher, taught, homerooms)),
        };
    });
}

// The filters, as one where clause: the ACTIVE members holding an ACTIVE STUDENT role,
// those sitting in a Class now when classId is given, and those whose name or NISN holds
// q. `contains` is a sequential scan by design, as the Schools' list's is.
function buildStudentWhere({ q, classId }) {
    const all = [];

    if (classId) all.push({ studentProfile: { classMemberships: { some: { classId, endedAt: null } } } });
    if (q) {
        all.push({
            OR: [
                { user: { fullName: { contains: q, mode: 'insensitive' } } },
                { studentProfile: { nisn: { contains: q } } },
            ],
        });
    }

    return {
        status: 'ACTIVE',
        roles: { some: { role: 'STUDENT', status: 'ACTIVE' } },
        ...(all.length ? { AND: all } : {}),
    };
}

// GET /api/governing-body/schools/:id/students, for any admin: a page of Students by
// name, each with the Class they sit in now, and the number behind the page. The current
// year's Classes come along, for the filter.
async function listStudents(auth, schoolId, { q, classId, limit, offset }) {
    const school = await loadOwnSchool(auth, schoolId);
    const where = buildStudentWhere({ q, classId });

    return runInSchool(school.id, school.name, async () => {
        const term = await currentTermOf(school);
        const [students, total, classes] = await Promise.all([
            prisma.schoolMembership.findMany({
                where,
                select: studentSelect,
                orderBy: [{ user: { fullName: 'asc' } }, { id: 'asc' }],
                take: limit,
                skip: offset,
            }),
            prisma.schoolMembership.count({ where }),
            term.year
                ? prisma.class.findMany({
                    where: { academicYearId: term.year.id },
                    select: { id: true, name: true, gradeLevel: true },
                    orderBy: [{ gradeLevel: 'asc' }, { name: 'asc' }],
                })
                : [],
        ]);

        return {
            students: students.map(studentView),
            total,
            page: { limit, offset, returned: students.length },
            academicYear: termView(term).academicYear,
            classes,
        };
    });
}

export { listTeachers, listStudents };
