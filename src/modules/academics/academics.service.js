import { prisma } from '../../shared/prisma.js';
import { isValidGrade, phaseFor } from '../../shared/schoolType.js';
import { isPrincipal, isHomeroomOf, hasActiveRole } from '../../shared/guards.js';
import {
    assertClassSubjectRetryAllowed,
    assertRejectionReason,
    assertWithinRegistrationDeadline,
    recordAudit,
} from '../../shared/approval.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

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
    await assertPrincipal(auth);

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
    await assertPrincipal(auth);

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
async function listClassSubjects(auth, { status }) {
    const principal = await isPrincipal(auth.membershipId);

    const rows = await prisma.classSubject.findMany({
        where: principal
            ? { status: status ?? 'PENDING' }
            : { teacherMembershipId: auth.membershipId, ...(status ? { status } : {}) },
        select: classSubjectSelect,
        orderBy: { requestedAt: principal ? 'asc' : 'desc' },
    });

    return rows.map(classSubjectView);
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
    await assertPrincipal(auth);

    let trimmed = null;
    if (action === 'REJECT') {
        assertRejectionReason('REJECT', reason);
        trimmed = reason.trim();
    }

    await loadClassSubject(id);
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
    await assertPrincipal(auth);

    const { target } = await resolveSlot(body);
    const teacher = await resolveTeacher(body.teacherMembershipId, 'The teacher');
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
            return row;
        });
    } catch (error) {
        throw translateSlotTaken(error);
    }

    log.info(`Subject in ${target.name} assigned by override to ${teacher.user.fullName}`);
    return classSubjectView(await loadClassSubject(created.id));
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
    cancelClassSubject,
    approveClassSubject,
    rejectClassSubject,
    bulkApproveClassSubjects,
    overrideClassSubject,
};
