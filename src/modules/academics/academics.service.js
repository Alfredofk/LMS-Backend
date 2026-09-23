import { prisma } from '../../shared/prisma.js';
import { isValidGrade, phaseFor } from '../../shared/schoolType.js';
import { isPrincipal, isHomeroomOf } from '../../shared/guards.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('Academics');

// Academic period and class setup (ticket 07).
//
// Every route here is reached with a token that carries the school, so
// requireAuth has already opened the tenant scope: a year, class or teacher from
// another school is simply not found - 404, never 403 (ADR-0001).
//
// The Principal owns every write (decision #53): the academic year, its
// semesters, the classes and who is homeroom teacher of each. None of these is an
// approval, so nothing here writes ApprovalAudit (ADR-0003 keeps it for decisions).
//
// Owner's decisions (2026-09-23): several academic years may be ACTIVE at once,
// so next year can be prepared before this one closes; one teacher may be
// homeroom of several classes; the Principal may change a class's homeroom
// teacher. The SD special case - mandatory ClassSubjects created with the class -
// moved to ticket 08, where ClassSubject is built.

// Checked against the database, not the token's roles, the way
// rotateSchoolCode() does: a role withdrawn minutes ago must not still work.
async function assertPrincipal(auth) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden('Only the Principal can do this');
}

// Each table here is unique on what a Principal names, and a duplicate is a
// conflict worth saying in words rather than a Prisma code.
function translateUniqueViolation(error) {
    if (error?.code !== 'P2002') return error;

    const target = String(error.meta?.target ?? '');
    if (target.includes('label')) return conflict('An academic year with that label already exists');
    if (target.includes('ordinal')) return conflict('That semester already exists in this academic year');
    if (target.includes('name')) return conflict('A class with that name already exists this academic year');
    return error;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const semesterSelect = {
    id: true,
    ordinal: true,
    startDate: true,
    endDate: true,
    status: true,
    classSubjectRegistrationDeadline: true,
};

const yearSelect = {
    id: true,
    label: true,
    startDate: true,
    endDate: true,
    status: true,
    semesters: { select: semesterSelect, orderBy: { ordinal: 'asc' } },
};

const classSelect = {
    id: true,
    name: true,
    gradeLevel: true,
    academicYear: { select: { id: true, label: true, status: true } },
    homeroomTeacher: { select: { id: true, user: { select: { fullName: true } } } },
    _count: { select: { memberships: { where: { endedAt: null } } } },
};

// Phase is derived from the grade, never stored (shared/schoolType.js).
const classView = (target) => ({
    id: target.id,
    name: target.name,
    gradeLevel: target.gradeLevel,
    phase: phaseFor(target.gradeLevel),
    academicYear: target.academicYear,
    homeroomTeacher: target.homeroomTeacher
        ? {
            membershipId: target.homeroomTeacher.id,
            fullName: target.homeroomTeacher.user.fullName,
        }
        : null,
    studentCount: target._count.memberships,
});

// ---------------------------------------------------------------------------
// Teachers - who the Principal can name as homeroom teacher
// ---------------------------------------------------------------------------

async function listTeachers(auth) {
    await assertPrincipal(auth);

    const memberships = await prisma.schoolMembership.findMany({
        where: { status: 'ACTIVE', roles: { some: { role: 'TEACHER', status: 'ACTIVE' } } },
        select: {
            id: true,
            user: { select: { fullName: true } },
            teacherProfile: { select: { nip: true, nuptk: true } },
        },
        orderBy: { user: { fullName: 'asc' } },
    });

    return memberships.map((membership) => ({
        membershipId: membership.id,
        fullName: membership.user.fullName,
        nip: membership.teacherProfile?.nip ?? null,
        nuptk: membership.teacherProfile?.nuptk ?? null,
    }));
}

// A homeroom teacher is an ACTIVE member of this school holding an ACTIVE
// TEACHER role. A Principal qualifies only if they teach as well. An id that is
// unknown, from another school, or a membership that is not ACTIVE is simply not
// found; a real member without TEACHER is told why.
async function resolveHomeroomTeacher(membershipId) {
    const membership = await prisma.schoolMembership.findFirst({
        where: { id: membershipId, status: 'ACTIVE' },
        select: {
            id: true,
            user: { select: { fullName: true } },
            roles: { where: { role: 'TEACHER', status: 'ACTIVE' }, select: { id: true } },
        },
    });
    if (!membership) throw notFound('Teacher not found');
    if (membership.roles.length === 0) {
        throw badRequest('The homeroom teacher must be an active teacher at this school');
    }
    return membership;
}

// ---------------------------------------------------------------------------
// Academic year
// ---------------------------------------------------------------------------

async function loadYear(id) {
    const year = await prisma.academicYear.findFirst({ where: { id }, select: yearSelect });
    if (!year) throw notFound('Academic year not found');
    return year;
}

// A CLOSED year keeps everything it holds, readable, and takes nothing new.
function assertYearOpen(year) {
    if (year.status !== 'ACTIVE') throw conflict(`Academic year ${year.label} is closed`);
}

async function createAcademicYear(auth, body) {
    await assertPrincipal(auth);

    try {
        const created = await prisma.academicYear.create({
            data: { label: body.label, startDate: body.startDate, endDate: body.endDate },
            select: { id: true },
        });
        log.info(`Academic year ${body.label} created`);
        return loadYear(created.id);
    } catch (error) {
        throw translateUniqueViolation(error);
    }
}

// Newest first: the year being worked in is the one a screen opens on.
async function listAcademicYears() {
    return prisma.academicYear.findMany({ select: yearSelect, orderBy: { startDate: 'desc' } });
}

// ACTIVE -> CLOSED, claimed like every transition here, so closing twice is a
// conflict. No semester has to be closed first: semester close is two-phase and
// not built yet (ticket 07 leaves it to its own work).
async function closeAcademicYear(auth, id) {
    await assertPrincipal(auth);
    const year = await loadYear(id);

    const claimed = await prisma.academicYear.updateMany({
        where: { id, status: 'ACTIVE' },
        data: { status: 'CLOSED' },
    });
    if (claimed.count === 0) throw conflict(`Academic year ${year.label} is already closed`);

    log.info(`Academic year ${year.label} closed`);
    return loadYear(id);
}

// ---------------------------------------------------------------------------
// Semester
// ---------------------------------------------------------------------------

// One of the year's two halves: inside the year's dates, clear of the other half,
// and with its registration deadline (if any) inside itself.
async function createSemester(auth, academicYearId, body) {
    await assertPrincipal(auth);
    const year = await loadYear(academicYearId);
    assertYearOpen(year);

    const { ordinal, startDate, endDate, classSubjectRegistrationDeadline: deadline } = body;

    if (startDate < year.startDate || endDate > year.endDate) {
        throw badRequest(`Semester ${ordinal} must fall inside academic year ${year.label}`);
    }

    const other = year.semesters.find((semester) => semester.ordinal !== ordinal);
    if (other && startDate < other.endDate && endDate > other.startDate) {
        throw badRequest(`Semester ${ordinal} overlaps semester ${other.ordinal}`);
    }

    if (deadline && (deadline < startDate || deadline > endDate)) {
        throw badRequest('The registration deadline must fall inside the semester');
    }

    try {
        await prisma.semester.create({
            data: {
                academicYearId,
                ordinal,
                startDate,
                endDate,
                classSubjectRegistrationDeadline: deadline ?? null,
            },
        });
    } catch (error) {
        throw translateUniqueViolation(error);
    }

    log.info(`Semester ${ordinal} of ${year.label} created`);
    return loadYear(academicYearId);
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

async function loadClass(id) {
    const target = await prisma.class.findFirst({ where: { id }, select: classSelect });
    if (!target) throw notFound('Class not found');
    return target;
}

// Created with its homeroom teacher in the same action (decision #53), so a class
// never exists without somebody to release its students' requests.
async function createClass(auth, body) {
    await assertPrincipal(auth);

    const year = await loadYear(body.academicYearId);
    assertYearOpen(year);

    // School is exempt from the tenant extension (it defines the tenant).
    const school = await prisma.school.findUnique({
        where: { id: auth.schoolId },
        select: { schoolType: true, durationYears: true },
    });
    if (!isValidGrade(school.schoolType, body.gradeLevel, school.durationYears)) {
        throw badRequest(`Grade ${body.gradeLevel} does not exist at a ${school.schoolType}`, {
            gradeLevel: body.gradeLevel,
            schoolType: school.schoolType,
        });
    }

    const homeroom = await resolveHomeroomTeacher(body.homeroomTeacherMembershipId);

    let created;
    try {
        created = await prisma.class.create({
            data: {
                academicYearId: year.id,
                name: body.name,
                gradeLevel: body.gradeLevel,
                homeroomTeacherMembershipId: homeroom.id,
                createdByUserId: auth.userId,
            },
            select: { id: true },
        });
    } catch (error) {
        throw translateUniqueViolation(error);
    }

    log.info(`Class ${body.name} (${year.label}) created, homeroom ${homeroom.user.fullName}`);
    return classView(await loadClass(created.id));
}

// The Principal sees every class; a teacher, the classes they are homeroom of.
// A teacher's wider view - which classes they could teach - is ticket 08's.
async function listClasses(auth, { academicYearId }) {
    const principal = await isPrincipal(auth.membershipId);

    const classes = await prisma.class.findMany({
        where: {
            ...(academicYearId ? { academicYearId } : {}),
            ...(principal ? {} : { homeroomTeacherMembershipId: auth.membershipId }),
        },
        select: classSelect,
        orderBy: [{ gradeLevel: 'asc' }, { name: 'asc' }],
    });

    return classes.map(classView);
}

// One class and its current roster, for the Principal or its own homeroom
// teacher. Anybody else gets the same 404 a class at another school gets.
async function getClass(auth, id) {
    const allowed =
        (await isPrincipal(auth.membershipId)) || (await isHomeroomOf(auth.membershipId, id));
    if (!allowed) throw notFound('Class not found');

    const target = await loadClass(id);
    const placements = await prisma.classMembership.findMany({
        where: { classId: id, endedAt: null },
        select: {
            startedAt: true,
            studentProfile: {
                select: {
                    id: true,
                    nisn: true,
                    membership: { select: { user: { select: { fullName: true } } } },
                },
            },
        },
    });

    const students = placements
        .map((placement) => ({
            studentProfileId: placement.studentProfile.id,
            fullName: placement.studentProfile.membership.user.fullName,
            nisn: placement.studentProfile.nisn,
            placedAt: placement.startedAt,
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'id'));

    return { ...classView(target), students };
}

// Nothing else has to move with the homeroom teacher. reviewerScope() in
// membership.service.js reads Class.homeroomTeacherMembershipId on every request,
// so the class's PENDING student and guardian requests are in the new teacher's
// queue on their next read, and out of the old one's.
async function changeHomeroom(auth, id, { homeroomTeacherMembershipId }) {
    await assertPrincipal(auth);

    const target = await loadClass(id);
    if (target.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${target.academicYear.label} is closed`);
    }

    const homeroom = await resolveHomeroomTeacher(homeroomTeacherMembershipId);

    await prisma.class.updateMany({
        where: { id },
        data: { homeroomTeacherMembershipId: homeroom.id },
    });

    log.info(`Class ${target.name} (${target.academicYear.label}): homeroom now ${homeroom.user.fullName}`);
    return classView(await loadClass(id));
}

export {
    listTeachers,
    createAcademicYear,
    listAcademicYears,
    closeAcademicYear,
    createSemester,
    createClass,
    listClasses,
    getClass,
    changeHomeroom,
};
