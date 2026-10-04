import { prisma } from '../../shared/prisma.js';
import { isValidGrade, phaseFor } from '../../shared/schoolType.js';
import { isPrincipal, isPrincipalOrVice, isHomeroomOf, hasActiveRole, currentPlacement } from '../../shared/guards.js';
import {
    assertClassSubjectRetryAllowed,
    assertRejectionReason,
    assertWithinRegistrationDeadline,
    recordAudit,
} from '../../shared/approval.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import {
    inheritSchedule,
    stopSessionsAhead,
    assertSemesterDatesMayChange,
    regenerateSemester,
} from '../sessions/sessions.service.js';

const log = createLogger('Academics');

// Academic period and class setup (ticket 07), and subjects and teaching
// assignments (ticket 08).
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
// Everything this module guards is the academic day-to-day, which a Vice
// Principal runs too (registration-and-membership ticket 19).
async function assertPrincipalOrVice(auth) {
    if (!(await isPrincipalOrVice(auth.membershipId))) {
        throw forbidden('Only the Principal or a Vice Principal can do this');
    }
}

// A Vice Principal is also a teacher, and never decides their own teaching: not
// approving or rejecting their own request, not overriding one for themselves
// (ticket 19). The Principal is left as before.
async function assertNotDecidingForSelf(auth, teacherMembershipId) {
    if (teacherMembershipId !== auth.membershipId) return;
    if (await isPrincipal(auth.membershipId)) return;
    throw forbidden('A Vice Principal cannot decide their own teaching assignment');
}

// Each table here is unique on what a Principal names, and a duplicate is a
// conflict worth saying in words rather than a Prisma code.
function translateUniqueViolation(error) {
    if (error?.code !== 'P2002') return error;

    const target = String(error.meta?.target ?? '');
    if (target.includes('label')) return conflict('An academic year with that label already exists');
    if (target.includes('ordinal')) return conflict('That semester already exists in this academic year');
    if (target.includes('code')) return conflict('This school already has a subject with that code');
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
    await assertPrincipalOrVice(auth);

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

// A teacher named by the Principal - as a class's homeroom teacher, or on an
// override ClassSubject - is an ACTIVE member of this school holding an ACTIVE
// TEACHER role. A Principal qualifies only if they teach as well. An id that is
// unknown, from another school, or a membership that is not ACTIVE is simply not
// found; a real member without TEACHER is told why.
async function resolveTeacher(membershipId, who = 'The homeroom teacher') {
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
        throw badRequest(`${who} must be an active teacher at this school`);
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

// "2026/2027" runs from a day in 2026 to a day in 2027. Nothing downstream reads
// the label - semesters, sessions and holidays run on the dates - but it is what
// every screen and report card shows, it is unique per school, and a closed
// year's label can no longer be corrected. So a label that disagrees with its
// dates is refused rather than left to mislead. The dates are day values
// (midnight UTC), so the UTC year is the calendar year.
function assertYearMatchesLabel(label, startDate, endDate) {
    const first = Number(label.slice(0, 4));
    const second = Number(label.slice(5));

    if (startDate.getUTCFullYear() !== first || endDate.getUTCFullYear() !== second) {
        throw badRequest(`Academic year ${label} must start in ${first} and end in ${second}`);
    }
}

// Two years of one school never share a day, whatever their labels: the label
// check alone still lets 2026/2027 and 2027/2028 both claim the spring of 2027.
// The same overlap test as assertSemesterFits. Closed years count too.
async function assertNoYearOverlap(startDate, endDate, exceptId) {
    const other = await prisma.academicYear.findFirst({
        where: {
            ...(exceptId ? { id: { not: exceptId } } : {}),
            startDate: { lt: endDate },
            endDate: { gt: startDate },
        },
        select: { label: true },
    });
    if (other) throw conflict(`The dates overlap academic year ${other.label}`);
}

async function createAcademicYear(auth, body) {
    await assertPrincipalOrVice(auth);
    assertYearMatchesLabel(body.label, body.startDate, body.endDate);
    await assertNoYearOverlap(body.startDate, body.endDate);

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
    await assertPrincipalOrVice(auth);
    const year = await loadYear(id);

    const claimed = await prisma.academicYear.updateMany({
        where: { id, status: 'ACTIVE' },
        data: { status: 'CLOSED' },
    });
    if (claimed.count === 0) throw conflict(`Academic year ${year.label} is already closed`);

    log.info(`Academic year ${year.label} closed`);
    return loadYear(id);
}

// Correcting an ACTIVE year's label or dates (owner, 2026-09-26). The dates must
// still hold every semester already in it; a CLOSED year stays as it was closed.
async function updateAcademicYear(auth, id, body) {
    await assertPrincipalOrVice(auth);
    const year = await loadYear(id);
    assertYearOpen(year);

    const startDate = body.startDate ?? year.startDate;
    const endDate = body.endDate ?? year.endDate;
    if (startDate >= endDate) throw badRequest('The year must end after it starts');
    assertYearMatchesLabel(body.label ?? year.label, startDate, endDate);
    await assertNoYearOverlap(startDate, endDate, id);

    const outside = year.semesters.find(
        (semester) => semester.startDate < startDate || semester.endDate > endDate
    );
    if (outside) {
        throw badRequest(`Semester ${outside.ordinal} would fall outside the academic year`);
    }

    try {
        await prisma.academicYear.updateMany({
            where: { id },
            data: { ...(body.label ? { label: body.label } : {}), startDate, endDate },
        });
    } catch (error) {
        throw translateUniqueViolation(error);
    }

    log.info(`Academic year ${year.label} edited${body.label ? `, now ${body.label}` : ''}`);
    return loadYear(id);
}

// Only an empty year can go (owner, 2026-09-26): a year made by mistake, before
// anything was put in it. Emptiness is part of the delete's own where clause, so
// a semester or class added a moment earlier is never taken with it - the
// cascade would otherwise remove them.
async function deleteAcademicYear(auth, id) {
    await assertPrincipalOrVice(auth);
    const year = await loadYear(id);

    const deleted = await prisma.academicYear.deleteMany({
        where: { id, semesters: { none: {} }, classes: { none: {} } },
    });
    if (deleted.count === 0) {
        throw conflict(
            `Academic year ${year.label} already has semesters or classes. ` +
                'Only an empty year can be deleted'
        );
    }

    log.info(`Academic year ${year.label} deleted`);
    return { id, label: year.label };
}

// ---------------------------------------------------------------------------
// Semester
// ---------------------------------------------------------------------------

// One of the year's two halves: inside the year's dates, clear of the other half,
// and with its registration deadline (if any) inside itself. Checked on create and
// on every edit.
function assertSemesterFits(year, { ordinal, startDate, endDate, deadline }) {
    if (startDate >= endDate) throw badRequest('The semester must end after it starts');

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
}

async function createSemester(auth, academicYearId, body) {
    await assertPrincipalOrVice(auth);
    const year = await loadYear(academicYearId);
    assertYearOpen(year);

    const { ordinal, startDate, endDate, classSubjectRegistrationDeadline: deadline } = body;
    assertSemesterFits(year, { ordinal, startDate, endDate, deadline });

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

// A semester, with its year for the checks both need. Another school's is 404.
async function loadSemester(id) {
    const semester = await prisma.semester.findFirst({
        where: { id },
        select: { ...semesterSelect, academicYearId: true },
    });
    if (!semester) throw notFound('Semester not found');
    return { semester, year: await loadYear(semester.academicYearId) };
}

// Correcting an OPEN semester's dates or its registration deadline (owner,
// 2026-09-26) - a deadline set wrong could not be put right before. The ordinal
// stays. A deadline moved later reopens self-assign; that is what moving it means.
async function updateSemester(auth, id, body) {
    await assertPrincipalOrVice(auth);
    const { semester, year } = await loadSemester(id);
    assertYearOpen(year);
    if (semester.status !== 'OPEN') throw conflict(`Semester ${semester.ordinal} is not open`);

    const startDate = body.startDate ?? semester.startDate;
    const endDate = body.endDate ?? semester.endDate;
    const deadline =
        body.classSubjectRegistrationDeadline === undefined
            ? semester.classSubjectRegistrationDeadline
            : body.classSubjectRegistrationDeadline;
    assertSemesterFits(year, { ordinal: semester.ordinal, startDate, endDate, deadline });

    // Its dates stay changeable after the start, within the limits sessions sets,
    // and every timetable in it follows the new dates (teaching-and-learning
    // tickets 02 and 09).
    const startMoved = startDate.getTime() !== semester.startDate.getTime();
    const datesChange = startMoved || endDate.getTime() !== semester.endDate.getTime();
    if (datesChange) {
        await assertSemesterDatesMayChange(auth.schoolId, { id, ...semester }, { startDate, endDate });
    }

    await prisma.semester.updateMany({
        where: { id },
        data: { startDate, endDate, classSubjectRegistrationDeadline: deadline },
    });
    if (datesChange) await regenerateSemester(auth.schoolId, id, { startMoved });

    log.info(`Semester ${semester.ordinal} of ${year.label} edited`);
    return loadYear(year.id);
}

// Only a semester nobody has asked to teach in yet (owner, 2026-09-26). Any
// ClassSubject counts, a rejected or cancelled one too: those rows are the
// audit's subjects, and the cascade would take them.
async function deleteSemester(auth, id) {
    await assertPrincipalOrVice(auth);
    const { semester, year } = await loadSemester(id);
    assertYearOpen(year);

    const deleted = await prisma.semester.deleteMany({
        where: { id, classSubjects: { none: {} } },
    });
    if (deleted.count === 0) {
        throw conflict(
            `Semester ${semester.ordinal} already has teaching assignments or requests. ` +
                'Only a semester without any can be deleted'
        );
    }

    log.info(`Semester ${semester.ordinal} of ${year.label} deleted`);
    return loadYear(year.id);
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

async function loadClass(id) {
    const target = await prisma.class.findFirst({ where: { id }, select: classSelect });
    if (!target) throw notFound('Class not found');
    return target;
}

// A grade that exists at this school's type: there is no grade 7 at an SD.
async function assertGradeExists(auth, gradeLevel) {
    // School is exempt from the tenant extension (it defines the tenant).
    const school = await prisma.school.findUnique({
        where: { id: auth.schoolId },
        select: { schoolType: true, durationYears: true },
    });
    if (!isValidGrade(school.schoolType, gradeLevel, school.durationYears)) {
        throw badRequest(`Grade ${gradeLevel} does not exist at a ${school.schoolType}`, {
            gradeLevel,
            schoolType: school.schoolType,
        });
    }
}

// Created with its homeroom teacher in the same action (decision #53), so a class
// never exists without somebody to release its students' requests.
async function createClass(auth, body) {
    await assertPrincipalOrVice(auth);

    const year = await loadYear(body.academicYearId);
    assertYearOpen(year);
    await assertGradeExists(auth, body.gradeLevel);

    const homeroom = await resolveTeacher(body.homeroomTeacherMembershipId);

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
    const principal = await isPrincipalOrVice(auth.membershipId);

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
        (await isPrincipalOrVice(auth.membershipId)) || (await isHomeroomOf(auth.membershipId, id));
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
                    membership: { select: { id: true, user: { select: { fullName: true } } } },
                },
            },
        },
    });

    const students = placements
        .map((placement) => ({
            // What POST /api/academics/class-moves takes (ticket 16).
            studentProfileId: placement.studentProfile.id,
            // What the Principal's POST /api/members/:id/remove takes (ticket 06).
            membershipId: placement.studentProfile.membership.id,
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
    await assertPrincipalOrVice(auth);

    const target = await loadClass(id);
    if (target.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${target.academicYear.label} is closed`);
    }

    const homeroom = await resolveTeacher(homeroomTeacherMembershipId);

    await prisma.class.updateMany({
        where: { id },
        data: { homeroomTeacherMembershipId: homeroom.id },
    });

    log.info(`Class ${target.name} (${target.academicYear.label}): homeroom now ${homeroom.user.fullName}`);
    return classView(await loadClass(id));
}

// Correcting a class's name or grade in an ACTIVE year (owner, 2026-09-26). The
// grade changes only while the class has never held a student: a placement,
// even an ended one, is history of a student sitting at that grade. That
// condition is in the update's own where clause, so a student placed a moment
// earlier cannot slip under it.
async function updateClass(auth, id, body) {
    await assertPrincipalOrVice(auth);

    const target = await loadClass(id);
    if (target.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${target.academicYear.label} is closed`);
    }

    const regrade = body.gradeLevel !== undefined && body.gradeLevel !== target.gradeLevel;
    if (!body.name && !regrade) return classView(target);
    if (regrade) await assertGradeExists(auth, body.gradeLevel);

    let updated;
    try {
        updated = await prisma.class.updateMany({
            where: { id, ...(regrade ? { memberships: { none: {} } } : {}) },
            data: {
                ...(body.name ? { name: body.name } : {}),
                ...(regrade ? { gradeLevel: body.gradeLevel } : {}),
            },
        });
    } catch (error) {
        throw translateUniqueViolation(error);
    }
    if (updated.count === 0) {
        throw conflict(`${target.name} has had students, so its grade can no longer change`);
    }

    log.info(`Class ${target.name} (${target.academicYear.label}) edited`);
    return classView(await loadClass(id));
}

// Only a class made by mistake (owner, 2026-09-26): no placement ever, no
// teaching assignment or request, no class move either way. The cascade would
// take all of those, so emptiness is the delete's own where clause.
async function deleteClass(auth, id) {
    await assertPrincipalOrVice(auth);

    const target = await loadClass(id);
    if (target.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${target.academicYear.label} is closed`);
    }

    const deleted = await prisma.class.deleteMany({
        where: {
            id,
            memberships: { none: {} },
            classSubjects: { none: {} },
            movesOut: { none: {} },
            movesIn: { none: {} },
        },
    });
    if (deleted.count === 0) {
        throw conflict(
            `${target.name} has had students, teaching assignments or class moves. ` +
                'Only an empty class can be deleted'
        );
    }

    log.info(`Class ${target.name} (${target.academicYear.label}) deleted`);
    return { id, name: target.name };
}

// ---------------------------------------------------------------------------
// Class moves (ticket 16)
// ---------------------------------------------------------------------------

// A student moved to another class of the same ACTIVE academic year, their
// membership ACTIVE throughout. The owner's rules (2026-09-24):
// - the homeroom teacher of the class the student sits in asks;
// - the homeroom teacher of the class they would move to decides - a class with
//   no homeroom teacher cannot take a move;
// - the grade may change (a student released into the wrong grade is put right);
// - the Principal takes no part.
//
// Both sides are read from Class.homeroomTeacherMembershipId when they act, not
// stored on the move, so a class handed to another homeroom teacher hands its
// moves over too - the way reviewerScope() treats join requests. The one
// exception is a homeroom teacher of both classes: nobody else could decide, so
// the move happens at once, audited SUBMIT and APPROVE by the same person.

const CLASS_MOVE = 'ClassMove';

const moveClassSelect = {
    id: true,
    name: true,
    gradeLevel: true,
    homeroomTeacherMembershipId: true,
};

const classMoveSelect = {
    id: true,
    status: true,
    reason: true,
    requestedAt: true,
    decidedAt: true,
    rejectionReason: true,
    studentProfile: {
        select: {
            id: true,
            nisn: true,
            membershipId: true,
            membership: { select: { user: { select: { fullName: true } } } },
        },
    },
    fromClass: { select: moveClassSelect },
    toClass: {
        select: { ...moveClassSelect, academicYear: { select: { label: true, status: true } } },
    },
};

// canDecide and canCancel tell a screen which buttons are this teacher's.
function classMoveView(row, membershipId) {
    const pending = row.status === 'PENDING';
    const classOf = (target) => ({
        id: target.id,
        name: target.name,
        gradeLevel: target.gradeLevel,
    });

    return {
        id: row.id,
        status: row.status,
        reason: row.reason,
        requestedAt: row.requestedAt,
        decidedAt: row.decidedAt,
        rejectionReason: row.rejectionReason,
        student: {
            studentProfileId: row.studentProfile.id,
            fullName: row.studentProfile.membership.user.fullName,
            nisn: row.studentProfile.nisn,
        },
        fromClass: classOf(row.fromClass),
        toClass: classOf(row.toClass),
        canDecide: pending && row.toClass.homeroomTeacherMembershipId === membershipId,
        canCancel: pending && row.fromClass.homeroomTeacherMembershipId === membershipId,
    };
}

async function loadClassMove(id) {
    const row = await prisma.classMove.findFirst({ where: { id }, select: classMoveSelect });
    if (!row) throw notFound('Class move not found');
    return row;
}

// A student on their way out waits for the Principal, not for a new class
// (ticket 17): approving the leave ends the placement anyway.
async function assertNotLeaving(membershipId) {
    const waiting = await prisma.leaveRequest.findFirst({
        where: { membershipId, status: 'PENDING' },
        select: { id: true },
    });
    if (waiting) throw conflict('This student has a leave request waiting for the Principal');
}

// The move itself: the old placement ends and stays as history, a new one opens.
// Ended first, because ClassMembership_one_active_per_student allows one open
// placement at a time.
async function applyClassMove(tx, { studentProfileId, fromClass, toClassId, now }) {
    const ended = await tx.classMembership.updateMany({
        where: { studentProfileId, classId: fromClass.id, endedAt: null },
        data: { endedAt: now },
    });
    if (ended.count === 0) throw conflict(`The student is no longer in ${fromClass.name}`);

    await tx.classMembership.create({
        data: { classId: toClassId, studentProfileId, startedAt: now },
    });
}

// Where a homeroom teacher may send a student of this class: every other class
// of its academic year. One without a homeroom teacher is listed too, marked, so
// the screen can say why it cannot be picked.
async function listMoveTargets(auth, classId) {
    if (!(await isHomeroomOf(auth.membershipId, classId))) throw notFound('Class not found');

    const from = await prisma.class.findFirst({
        where: { id: classId },
        select: { academicYearId: true },
    });
    const classes = await prisma.class.findMany({
        where: { academicYearId: from.academicYearId, id: { not: classId } },
        select: {
            id: true,
            name: true,
            gradeLevel: true,
            homeroomTeacher: { select: { id: true, user: { select: { fullName: true } } } },
        },
        orderBy: [{ gradeLevel: 'asc' }, { name: 'asc' }],
    });

    return classes.map((target) => ({
        id: target.id,
        name: target.name,
        gradeLevel: target.gradeLevel,
        homeroomTeacher: target.homeroomTeacher
            ? {
                membershipId: target.homeroomTeacher.id,
                fullName: target.homeroomTeacher.user.fullName,
            }
            : null,
        acceptsMoves: Boolean(target.homeroomTeacher),
    }));
}

// The origin homeroom teacher asks. A student who is not in one of this
// teacher's classes gets the same 404 as one at another school.
async function requestClassMove(auth, { studentProfileId, toClassId, reason }) {
    const placement = await prisma.classMembership.findFirst({
        where: { studentProfileId, endedAt: null, studentProfile: { membership: { status: 'ACTIVE' } } },
        select: {
            studentProfile: { select: { membershipId: true } },
            class: {
                select: {
                    ...moveClassSelect,
                    academicYearId: true,
                    academicYear: { select: { label: true, status: true } },
                },
            },
        },
    });
    if (!placement || placement.class.homeroomTeacherMembershipId !== auth.membershipId) {
        throw notFound('Student not found');
    }

    const from = placement.class;
    if (from.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${from.academicYear.label} is closed`);
    }

    const to = await prisma.class.findFirst({
        where: { id: toClassId },
        select: { ...moveClassSelect, academicYearId: true },
    });
    if (!to) throw notFound('Class not found');
    if (to.id === from.id) throw badRequest(`The student is already in ${from.name}`);
    if (to.academicYearId !== from.academicYearId) {
        throw badRequest('A student moves only to a class of the same academic year');
    }
    if (!to.homeroomTeacherMembershipId) {
        throw conflict(`${to.name} has no homeroom teacher to accept the move`);
    }

    await assertNotLeaving(placement.studentProfile.membershipId);

    const waiting = await prisma.classMove.findFirst({
        where: { studentProfileId, status: 'PENDING' },
        select: { id: true },
    });
    if (waiting) throw conflict('This student already has a class move waiting');

    const selfGranted = to.homeroomTeacherMembershipId === auth.membershipId;
    const now = new Date();

    let created;
    try {
        created = await prisma.$transaction(async (tx) => {
            const row = await tx.classMove.create({
                data: {
                    studentProfileId,
                    fromClassId: from.id,
                    toClassId: to.id,
                    requestedByUserId: auth.userId,
                    reason: reason ?? null,
                    ...(selfGranted
                        ? { status: 'ACTIVE', decidedByUserId: auth.userId, decidedAt: now }
                        : {}),
                },
                select: { id: true },
            });

            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: CLASS_MOVE,
                subjectId: row.id,
                action: 'SUBMIT',
                actorUserId: auth.userId,
                reason: reason ?? null,
                client: tx,
            });

            if (selfGranted) {
                await applyClassMove(tx, { studentProfileId, fromClass: from, toClassId: to.id, now });
                await recordAudit({
                    schoolId: auth.schoolId,
                    subjectType: CLASS_MOVE,
                    subjectId: row.id,
                    action: 'APPROVE',
                    actorUserId: auth.userId,
                    client: tx,
                });
            }
            return row;
        });
    } catch (error) {
        // ClassMove_one_pending_per_student, reached by two requests racing past
        // the check above.
        if (error?.code === 'P2002') throw conflict('This student already has a class move waiting');
        throw error;
    }

    log.info(`Class move ${from.name} -> ${to.name}${selfGranted ? ' (own classes, done at once)' : ' requested'}`);
    return classMoveView(await loadClassMove(created.id), auth.membershipId);
}

// Moves out of, or into, the classes this teacher is homeroom of. Every status
// unless one is asked for, newest first.
async function listClassMoves(auth, { status }) {
    const rows = await prisma.classMove.findMany({
        where: {
            OR: [
                { fromClass: { homeroomTeacherMembershipId: auth.membershipId } },
                { toClass: { homeroomTeacherMembershipId: auth.membershipId } },
            ],
            ...(status ? { status } : {}),
        },
        select: classMoveSelect,
        orderBy: { requestedAt: 'desc' },
    });
    return rows.map((row) => classMoveView(row, auth.membershipId));
}

// The receiving homeroom teacher's decision, claimed with
// updateMany({ status: 'PENDING' }) so it happens once. The move row is taken
// before the placement - the order endMembership() takes them in, so a student
// leaving at the same moment and this never wait on each other.
async function decideClassMove(auth, id, { action, reason }) {
    let trimmed = null;
    if (action === 'REJECT') {
        assertRejectionReason('REJECT', reason);
        trimmed = reason.trim();
    }

    const move = await loadClassMove(id);
    if (move.toClass.homeroomTeacherMembershipId !== auth.membershipId) {
        throw notFound('Class move not found');
    }
    if (action === 'APPROVE') {
        if (move.toClass.academicYear.status !== 'ACTIVE') {
            throw conflict(`Academic year ${move.toClass.academicYear.label} is closed`);
        }
        await assertNotLeaving(move.studentProfile.membershipId);
    }

    const now = new Date();

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.classMove.updateMany({
            where: { id, status: 'PENDING' },
            data:
                action === 'APPROVE'
                    ? { status: 'ACTIVE', decidedByUserId: auth.userId, decidedAt: now }
                    : {
                        status: 'REJECTED',
                        decidedByUserId: auth.userId,
                        decidedAt: now,
                        rejectionReason: trimmed,
                    },
        });
        if (claimed.count === 0) throw conflict('This class move has already been decided');

        if (action === 'APPROVE') {
            await applyClassMove(tx, {
                studentProfileId: move.studentProfile.id,
                fromClass: move.fromClass,
                toClassId: move.toClass.id,
                now,
            });
        }

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: CLASS_MOVE,
            subjectId: id,
            action,
            actorUserId: auth.userId,
            reason: trimmed,
            client: tx,
        });
    });

    log.info(`Class move ${move.fromClass.name} -> ${move.toClass.name} ${action === 'APPROVE' ? 'approved' : 'rejected'}`);
    return classMoveView(await loadClassMove(id), auth.membershipId);
}

const approveClassMove = (auth, id) => decideClassMove(auth, id, { action: 'APPROVE' });

const rejectClassMove = (auth, id, { reason } = {}) =>
    decideClassMove(auth, id, { action: 'REJECT', reason });

// The asking side taking a waiting move back: whoever is homeroom teacher of the
// class the student sits in now. Anyone else, or a decided move, is the same 404.
async function cancelClassMove(auth, id) {
    const move = await loadClassMove(id);
    if (move.status !== 'PENDING' || move.fromClass.homeroomTeacherMembershipId !== auth.membershipId) {
        throw notFound('No class move of yours is waiting under that id');
    }

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.classMove.updateMany({
            where: { id, status: 'PENDING' },
            data: { status: 'CANCELLED' },
        });
        if (claimed.count === 0) throw conflict('This class move has already been decided');

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: CLASS_MOVE,
            subjectId: id,
            action: 'CANCEL',
            actorUserId: auth.userId,
            client: tx,
        });
    });

    return classMoveView(await loadClassMove(id), auth.membershipId);
}

// ---------------------------------------------------------------------------
// Subjects (ticket 08)
// ---------------------------------------------------------------------------

// The national catalog (schoolId null, from migration national_subject_catalog)
// plus this school's local subjects. The tenant extension reads both for Subject
// (CATALOG_MODELS in shared/prisma.js), so nothing here names a school.
async function listSubjects() {
    const subjects = await prisma.subject.findMany({
        select: { id: true, code: true, name: true, schoolId: true },
        orderBy: { code: 'asc' },
    });

    return subjects
        .map((subject) => ({
            id: subject.id,
            code: subject.code,
            name: subject.name,
            national: subject.schoolId === null,
        }))
        .sort((a, b) => Number(b.national) - Number(a.national));
}

// A local subject (muatan lokal). The extension stamps this school onto it.
async function createSubject(auth, body) {
    await assertPrincipalOrVice(auth);

    try {
        const created = await prisma.subject.create({
            data: { code: body.code, name: body.name },
            select: { id: true, code: true, name: true },
        });
        log.info(`Local subject ${created.code} created`);
        return { ...created, national: false };
    } catch (error) {
        throw translateUniqueViolation(error);
    }
}

// ---------------------------------------------------------------------------
// ClassSubject - who teaches what, where (ticket 08, handoff #54-#57)
// ---------------------------------------------------------------------------

// Handoff "Hole 2": a teacher who could add any subject to any class would gain
// authority over those students by self-service. The containment is the
// approval gate plus the semester's deadline, not a ban on self-assignment.
//
// The one exception (owner, 2026-09-24): a homeroom teacher taking a subject in
// their own class is ACTIVE at once, at every school type - the Principal named
// them that class's homeroom teacher. It replaces the ticket's SD special case,
// where the class teacher teaches every subject: no mandatory list is hardcoded
// and nothing is created behind anyone's back.

const CLASS_SUBJECT = 'ClassSubject';

const classSubjectSelect = {
    id: true,
    status: true,
    requestedAt: true,
    decidedAt: true,
    rejectionReason: true,
    createdViaOverride: true,
    endedAt: true,
    endReason: true,
    class: { select: { id: true, name: true, gradeLevel: true } },
    subject: { select: { id: true, code: true, name: true } },
    semester: { select: { id: true, ordinal: true, academicYear: { select: { label: true } } } },
    teacher: { select: { id: true, user: { select: { fullName: true } } } },
};

const classSubjectView = (row) => ({
    id: row.id,
    status: row.status,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    rejectionReason: row.rejectionReason,
    createdViaOverride: row.createdViaOverride,
    endedAt: row.endedAt,
    endReason: row.endReason,
    class: row.class,
    subject: row.subject,
    semester: {
        id: row.semester.id,
        ordinal: row.semester.ordinal,
        academicYear: row.semester.academicYear.label,
    },
    teacher: { membershipId: row.teacher.id, fullName: row.teacher.user.fullName },
});

async function loadClassSubject(id) {
    const row = await prisma.classSubject.findFirst({ where: { id }, select: classSubjectSelect });
    if (!row) throw notFound('Teaching assignment not found');
    return row;
}

// One teacher per class + subject + semester is the partial unique index
// ClassSubject_one_pending_or_active_per_slot (PENDING or ACTIVE, not ended), so
// a clash is said in words rather than as a Prisma code.
function translateSlotTaken(error) {
    if (error?.code !== 'P2002') return error;
    return conflict('This subject already has a teacher, or a request waiting, in this class this semester');
}

// A slot: a class, a subject, a semester - all at this school, the class and the
// semester in the same ACTIVE academic year, and the semester still OPEN.
async function resolveSlot({ classId, subjectId, semesterId }) {
    const target = await prisma.class.findFirst({
        where: { id: classId },
        select: {
            id: true,
            name: true,
            academicYearId: true,
            homeroomTeacherMembershipId: true,
            academicYear: { select: { label: true, status: true } },
        },
    });
    if (!target) throw notFound('Class not found');

    const semester = await prisma.semester.findFirst({
        where: { id: semesterId },
        select: {
            id: true,
            ordinal: true,
            status: true,
            academicYearId: true,
            classSubjectRegistrationDeadline: true,
        },
    });
    if (!semester) throw notFound('Semester not found');

    // National or this school's: the extension hides every other school's.
    const subject = await prisma.subject.findFirst({
        where: { id: subjectId },
        select: { id: true, code: true },
    });
    if (!subject) throw notFound('Subject not found');

    if (semester.academicYearId !== target.academicYearId) {
        throw badRequest('The class and the semester belong to different academic years');
    }
    if (target.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${target.academicYear.label} is closed`);
    }
    if (semester.status !== 'OPEN') throw conflict(`Semester ${semester.ordinal} is not open`);

    return { target, semester, subject };
}

// Every class of the semester's year and the subjects being taught in it: who,
// and whether it is still waiting. Any teacher reads it (owner, 2026-09-24) - it
// is how they see what is free. No student is in it.
async function subjectBoard(semesterId) {
    const semester = await prisma.semester.findFirst({
        where: { id: semesterId },
        select: {
            id: true,
            ordinal: true,
            status: true,
            academicYearId: true,
            classSubjectRegistrationDeadline: true,
            academicYear: { select: { label: true } },
        },
    });
    if (!semester) throw notFound('Semester not found');

    const classes = await prisma.class.findMany({
        where: { academicYearId: semester.academicYearId },
        select: {
            id: true,
            name: true,
            gradeLevel: true,
            homeroomTeacher: { select: { id: true, user: { select: { fullName: true } } } },
            classSubjects: {
                where: { semesterId, status: { in: ['PENDING', 'ACTIVE'] }, endedAt: null },
                select: {
                    id: true,
                    status: true,
                    subject: { select: { id: true, code: true, name: true } },
                    teacher: { select: { id: true, user: { select: { fullName: true } } } },
                },
            },
        },
        orderBy: [{ gradeLevel: 'asc' }, { name: 'asc' }],
    });

    return {
        semester: {
            id: semester.id,
            ordinal: semester.ordinal,
            status: semester.status,
            academicYear: semester.academicYear.label,
            classSubjectRegistrationDeadline: semester.classSubjectRegistrationDeadline,
        },
        classes: classes.map((target) => ({
            id: target.id,
            name: target.name,
            gradeLevel: target.gradeLevel,
            homeroomTeacher: target.homeroomTeacher
                ? {
                    membershipId: target.homeroomTeacher.id,
                    fullName: target.homeroomTeacher.user.fullName,
                }
                : null,
            subjects: target.classSubjects
                .map((row) => ({
                    classSubjectId: row.id,
                    status: row.status,
                    subject: row.subject,
                    teacher: { membershipId: row.teacher.id, fullName: row.teacher.user.fullName },
                }))
                .sort((a, b) => a.subject.code.localeCompare(b.subject.code)),
        })),
    };
}

// A teacher taking a subject on, for themselves. PENDING for the Principal, or
// ACTIVE at once in their own homeroom class.
async function requestClassSubject(auth, body) {
    if (!(await hasActiveRole(auth.membershipId, 'TEACHER'))) {
        throw forbidden('Only a teacher can take on a subject');
    }

    const { target, semester } = await resolveSlot(body);
    assertWithinRegistrationDeadline(semester);
    await assertClassSubjectRetryAllowed({
        teacherMembershipId: auth.membershipId,
        classId: body.classId,
        subjectId: body.subjectId,
        semesterId: body.semesterId,
    });

    const selfGranted = target.homeroomTeacherMembershipId === auth.membershipId;
    const now = new Date();

    let created;
    try {
        created = await prisma.$transaction(async (tx) => {
            const row = await tx.classSubject.create({
                data: {
                    classId: body.classId,
                    subjectId: body.subjectId,
                    semesterId: body.semesterId,
                    teacherMembershipId: auth.membershipId,
                    ...(selfGranted
                        ? { status: 'ACTIVE', decidedByUserId: auth.userId, decidedAt: now }
                        : {}),
                },
                select: { id: true },
            });

            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: CLASS_SUBJECT,
                subjectId: row.id,
                action: 'SUBMIT',
                actorUserId: auth.userId,
                client: tx,
            });
            if (selfGranted) {
                await recordAudit({
                    schoolId: auth.schoolId,
                    subjectType: CLASS_SUBJECT,
                    subjectId: row.id,
                    action: 'APPROVE',
                    actorUserId: auth.userId,
                    client: tx,
                });
                // Taking over a slot whose teacher left: the timetable comes along.
                await inheritSchedule(tx, { id: row.id, ...body }, now);
            }
            return row;
        });
    } catch (error) {
        throw translateSlotTaken(error);
    }

    log.info(`Subject requested in ${target.name}${selfGranted ? ' (own homeroom class)' : ''}`);
    return classSubjectView(await loadClassSubject(created.id));
}

// The Principal's queue (PENDING unless asked otherwise, oldest first), or a
// teacher's own requests, every status unless one is asked for.
//
// A Vice Principal is also a teacher, and would otherwise only ever see the
// queue: `mine` asks for the teacher's answer whoever is asking.
async function listClassSubjects(auth, { status, mine }) {
    const principal = !mine && (await isPrincipalOrVice(auth.membershipId));

    const rows = await prisma.classSubject.findMany({
        where: principal
            ? { status: status ?? 'PENDING' }
            : { teacherMembershipId: auth.membershipId, ...(status ? { status } : {}) },
        select: classSubjectSelect,
        orderBy: { requestedAt: principal ? 'asc' : 'desc' },
    });

    return rows.map(classSubjectView);
}

// The live ClassSubjects of the Class a student is placed in now (teaching-and-
// learning spec, invariant 6), every semester of its academic year, in the order a
// student reads them - each with the caller's own select. Nothing PENDING, nothing
// ended. No placement, no rows. Shared by the student's own subjects below and
// their progress (teaching-and-learning 06), so both list the same ClassSubjects.
async function liveClassSubjectsOfStudent(membershipId, select) {
    const placement = await currentPlacement(membershipId);
    if (!placement) return { placement: null, rows: [] };

    const rows = await prisma.classSubject.findMany({
        where: { classId: placement.classId, status: 'ACTIVE', endedAt: null },
        select,
        orderBy: [{ semester: { ordinal: 'asc' } }, { subject: { code: 'asc' } }],
    });
    return { placement, rows };
}

// A student's own subjects (2026-10-03), and who teaches each. None of the staff's
// bookkeeping - when it was asked for or decided, an override.
async function listOwnClassSubjects(auth) {
    const { rows } = await liveClassSubjectsOfStudent(auth.membershipId, classSubjectSelect);
    return rows.map((row) => ({
        id: row.id,
        class: { id: row.class.id, name: row.class.name },
        subject: row.subject,
        semester: {
            id: row.semester.id,
            ordinal: row.semester.ordinal,
            academicYear: row.semester.academicYear.label,
        },
        teacher: { fullName: row.teacher.user.fullName },
    }));
}

// A teacher taking their own PENDING request back (the cancellation pattern of
// ticket 05). Anyone else's, or a decided one, is the same 404.
async function cancelClassSubject(auth, id) {
    await prisma.$transaction(async (tx) => {
        const claimed = await tx.classSubject.updateMany({
            where: { id, teacherMembershipId: auth.membershipId, status: 'PENDING' },
            data: { status: 'CANCELLED' },
        });
        if (claimed.count === 0) throw notFound('No request of yours is waiting under that id');

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: CLASS_SUBJECT,
            subjectId: id,
            action: 'CANCEL',
            actorUserId: auth.userId,
            client: tx,
        });
    });

    return classSubjectView(await loadClassSubject(id));
}

// The Principal's decision, claimed with updateMany({ status: 'PENDING' }) so it
// happens exactly once. A rejection carries its reason back to the teacher, who
// may ask again: a REJECTED row leaves the slot index, and the next request is a
// new row, capped by assertClassSubjectRetryAllowed.
async function decideClassSubject(auth, id, { action, reason }) {
    await assertPrincipalOrVice(auth);

    let trimmed = null;
    if (action === 'REJECT') {
        assertRejectionReason('REJECT', reason);
        trimmed = reason.trim();
    }

    const row = await loadClassSubject(id);
    await assertNotDecidingForSelf(auth, row.teacher.id);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.classSubject.updateMany({
            where: { id, status: 'PENDING' },
            data:
                action === 'APPROVE'
                    ? { status: 'ACTIVE', decidedByUserId: auth.userId, decidedAt: now }
                    : {
                        status: 'REJECTED',
                        decidedByUserId: auth.userId,
                        decidedAt: now,
                        rejectionReason: trimmed,
                    },
        });
        if (claimed.count === 0) throw conflict('This teaching request has already been decided');

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: CLASS_SUBJECT,
            subjectId: id,
            action,
            actorUserId: auth.userId,
            reason: trimmed,
            client: tx,
        });

        if (action === 'APPROVE') {
            await inheritSchedule(
                tx,
                {
                    id,
                    classId: row.class.id,
                    subjectId: row.subject.id,
                    semesterId: row.semester.id,
                },
                now
            );
        }
    });

    log.info(`Teaching request ${action === 'APPROVE' ? 'approved' : 'rejected'}`);
    return classSubjectView(await loadClassSubject(id));
}

const approveClassSubject = (auth, id) => decideClassSubject(auth, id, { action: 'APPROVE' });

const rejectClassSubject = (auth, id, { reason } = {}) =>
    decideClassSubject(auth, id, { action: 'REJECT', reason });

// Bulk approve, one transaction each, a result per id - the membership queue's
// shape. One bad id must not cost the Principal the other twenty.
async function bulkApproveClassSubjects(auth, { ids }) {
    const results = [];

    for (const id of ids) {
        try {
            const row = await approveClassSubject(auth, id);
            results.push({ id, ok: true, status: row.status });
        } catch (error) {
            results.push({
                id,
                ok: false,
                error: {
                    code: error?.expected ? error.code : 'INTERNAL_ERROR',
                    message: error?.expected ? error.message : 'Something went wrong',
                },
            });
            if (!error?.expected) log.error(`Bulk approve failed for ${id}`, error);
        }
    }

    return results;
}

// The Principal's path for a teacher who joins mid-semester (handoff #56): a
// ClassSubject ACTIVE at once, past the deadline, flagged createdViaOverride and
// audited OVERRIDE. Principal-only, and not a general back door - the slot,
// year and semester rules still hold.
async function overrideClassSubject(auth, body) {
    await assertPrincipalOrVice(auth);

    const { target } = await resolveSlot(body);
    const teacher = await resolveTeacher(body.teacherMembershipId, 'The teacher');
    await assertNotDecidingForSelf(auth, teacher.id);
    const now = new Date();

    let created;
    try {
        created = await prisma.$transaction(async (tx) => {
            const row = await tx.classSubject.create({
                data: {
                    classId: body.classId,
                    subjectId: body.subjectId,
                    semesterId: body.semesterId,
                    teacherMembershipId: teacher.id,
                    status: 'ACTIVE',
                    decidedByUserId: auth.userId,
                    decidedAt: now,
                    createdViaOverride: true,
                },
                select: { id: true },
            });

            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: CLASS_SUBJECT,
                subjectId: row.id,
                action: 'OVERRIDE',
                actorUserId: auth.userId,
                client: tx,
            });
            await inheritSchedule(tx, { id: row.id, ...body }, now);
            return row;
        });
    } catch (error) {
        throw translateSlotTaken(error);
    }

    log.info(`Subject in ${target.name} assigned by override to ${teacher.user.fullName}`);
    return classSubjectView(await loadClassSubject(created.id));
}

// ---------------------------------------------------------------------------
// Ending or replacing an assignment while its teacher stays (t&l ticket 10)
// ---------------------------------------------------------------------------
//
// Owner's decisions, 2026-09-29:
// - the Principal or a Vice Principal, never a Vice Principal on their own
//   assignment or naming themselves; the teacher cannot give one up;
// - a reason always, which the teacher sees;
// - at once, as a leave is: a Session under way or past stays with the old row.
// The old row ends the way a leaver's does - endedAt, kept as history, the slot
// freed - and is audited END, not REMOVE, which is a member leaving the school.

// An assignment that can still be ended: ACTIVE, not ended, in an OPEN Semester of
// an ACTIVE year. PENDING, ended, or another school's is the same 404.
async function loadLiveAssignment(id) {
    const row = await prisma.classSubject.findFirst({
        where: { id, status: 'ACTIVE', endedAt: null },
        select: {
            ...classSubjectSelect,
            semester: {
                select: {
                    id: true,
                    ordinal: true,
                    status: true,
                    academicYear: { select: { label: true, status: true } },
                },
            },
        },
    });
    if (!row) throw notFound('No active teaching assignment under that id');
    if (row.semester.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${row.semester.academicYear.label} is closed`);
    }
    if (row.semester.status !== 'OPEN') throw conflict(`Semester ${row.semester.ordinal} is not open`);
    return row;
}

// Claimed with updateMany on endedAt null, so it ends exactly once; audited END
// with its reason.
async function endAssignment(tx, auth, id, reason, now) {
    const claimed = await tx.classSubject.updateMany({
        where: { id, status: 'ACTIVE', endedAt: null },
        data: { endedAt: now, endReason: reason },
    });
    if (claimed.count === 0) throw conflict('This teaching assignment has already ended');

    await recordAudit({
        schoolId: auth.schoolId,
        subjectType: CLASS_SUBJECT,
        subjectId: id,
        action: 'END',
        actorUserId: auth.userId,
        reason,
        client: tx,
    });
}

// "Replace with teacher X": the old row ends and the new one starts ACTIVE in one
// transaction, so the class is never without a teacher. The new row comes in the
// override's way - flagged, audited OVERRIDE, whatever the deadline - and
// inherits the timetable and every Session still ahead.
async function replaceClassSubject(auth, id, { teacherMembershipId, reason }) {
    await assertPrincipalOrVice(auth);
    assertRejectionReason('END', reason);
    const trimmed = reason.trim();

    const row = await loadLiveAssignment(id);
    await assertNotDecidingForSelf(auth, row.teacher.id);
    const teacher = await resolveTeacher(teacherMembershipId, 'The new teacher');
    if (teacher.id === row.teacher.id) throw badRequest('That teacher already teaches it');
    await assertNotDecidingForSelf(auth, teacher.id);
    const now = new Date();

    const slot = { classId: row.class.id, subjectId: row.subject.id, semesterId: row.semester.id };
    let created;
    try {
        created = await prisma.$transaction(async (tx) => {
            await endAssignment(tx, auth, id, trimmed, now);

            const next = await tx.classSubject.create({
                data: {
                    ...slot,
                    teacherMembershipId: teacher.id,
                    status: 'ACTIVE',
                    decidedByUserId: auth.userId,
                    decidedAt: now,
                    createdViaOverride: true,
                },
                select: { id: true },
            });
            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: CLASS_SUBJECT,
                subjectId: next.id,
                action: 'OVERRIDE',
                actorUserId: auth.userId,
                client: tx,
            });
            await inheritSchedule(tx, { id: next.id, ...slot }, now);
            return next;
        });
    } catch (error) {
        throw translateSlotTaken(error);
    }

    log.info(
        `${row.subject.code} in ${row.class.name} handed from ${row.teacher.user.fullName} ` +
            `to ${teacher.user.fullName}`
    );
    return {
        ended: classSubjectView(await loadClassSubject(id)),
        classSubject: classSubjectView(await loadClassSubject(created.id)),
    };
}

// "End only". With a successor to follow, nothing else changes: the Sessions
// ahead wait on the ended row, as a leaver's do, until an override or an approval
// in the slot inherits them. When the subject stops, they are cancelled and the
// timetable put away (stopSessionsAhead).
async function endClassSubject(auth, id, { reason, subjectStops }) {
    await assertPrincipalOrVice(auth);
    assertRejectionReason('END', reason);
    const trimmed = reason.trim();

    const row = await loadLiveAssignment(id);
    await assertNotDecidingForSelf(auth, row.teacher.id);
    const now = new Date();

    const cancelled = await prisma.$transaction(async (tx) => {
        await endAssignment(tx, auth, id, trimmed, now);
        return subjectStops ? stopSessionsAhead(tx, id, now) : 0;
    });

    log.info(
        `${row.subject.code} in ${row.class.name} ended for ${row.teacher.user.fullName}` +
            (subjectStops ? `, the subject stops (${cancelled} session(s) cancelled)` : ', a successor to follow')
    );
    return classSubjectView(await loadClassSubject(id));
}

export {
    listTeachers,
    createAcademicYear,
    listAcademicYears,
    closeAcademicYear,
    updateAcademicYear,
    deleteAcademicYear,
    createSemester,
    updateSemester,
    deleteSemester,
    createClass,
    listClasses,
    getClass,
    changeHomeroom,
    updateClass,
    deleteClass,
    listMoveTargets,
    requestClassMove,
    listClassMoves,
    approveClassMove,
    rejectClassMove,
    cancelClassMove,
    listSubjects,
    createSubject,
    subjectBoard,
    requestClassSubject,
    listClassSubjects,
    listOwnClassSubjects,
    liveClassSubjectsOfStudent,
    cancelClassSubject,
    approveClassSubject,
    rejectClassSubject,
    bulkApproveClassSubjects,
    overrideClassSubject,
    replaceClassSubject,
    endClassSubject,
};
