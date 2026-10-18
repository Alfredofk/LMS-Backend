import { Prisma } from '@prisma/client';

import { prisma } from '../../shared/prisma.js';
import { assertPrincipalOrVice } from '../../shared/guards.js';
import { recordAudit } from '../../shared/approval.js';
import { isValidGrade } from '../../shared/schoolType.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { onCalendarChanged } from '../sessions/sessions.service.js';
import { toDate, toDay, daysBetween } from './holidays.calendar.js';

const log = createLogger('Holidays');

// Exam Weeks (teaching-and-learning ticket 13): a run of a Semester's days with no
// teaching for the grade levels it names, kept for a UTS or a UAS. Not a holiday:
// the other grade levels are taught as usual, so a grade 9 school exam sits apart
// from grades 7 and 8.
//
// Owner's decisions (2026-10-18):
// - Per grade level, one or more, never per Class. It belongs to one Semester, and
//   its days lie inside that Semester's; its grade levels are the Classes of that
//   Semester's year.
// - Typed UTS or UAS. A UTS or a UAS is published only inside one of its type for
//   its Class's grade level (assertInExamWeek in assessment.service.js). A make-up's
//   or a remedial's window is free.
// - Set and withdrawn by the Principal or a Vice Principal, and audited as a School
//   holiday is. Never edited: withdrawn, and set again. Every ACTIVE member reads them.
// - Two standing on a shared grade level never overlap, whatever their types.
// - Withdrawn while a published UTS or UAS lies in it, it goes all the same: the
//   Assessment keeps its window, and the rule binds when an Assessment is written.
//   Refusing would deadlock a week moved by a day or two.
// - Its days keep the Sessions of those Classes away as a holiday's do (sessions,
//   onCalendarChanged): planned around before the start, cancelled EXAM_WEEK after
//   it, taught again from tomorrow when it is withdrawn. A day both a holiday and an
//   Exam Week is a holiday.
//
// The defaults taken on the build plan (owner, 2026-10-18): set in an OPEN or a
// FINALIZING Semester of an ACTIVE year, at most 31 days, audited 'ExamWeek' with
// APPROVE / WITHDRAW, and the overlap check and the insert in one serializable
// transaction, so of two set at the same moment only one stands.

const EXAM_WEEK_SUBJECT = 'ExamWeek';

const SET_AT_ONCE = 'Exam Weeks were set at the same moment. Reload them and try again';

const semesterSelect = {
    id: true,
    ordinal: true,
    status: true,
    startDate: true,
    endDate: true,
    academicYear: { select: { label: true, status: true } },
};

const examWeekView = (row) => ({
    id: row.id,
    semesterId: row.semesterId,
    type: row.type,
    name: row.name,
    startDate: toDay(row.startDate),
    endDate: toDay(row.endDate),
    gradeLevels: row.gradeLevels,
    withdrawnAt: row.withdrawnAt,
});

// '2027-03-08 to 2027-03-13', for messages.
const describeDays = (row) => `${toDay(row.startDate)} to ${toDay(row.endDate)}`;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

async function loadSemester(id) {
    const semester = await prisma.semester.findFirst({ where: { id }, select: semesterSelect });
    if (!semester) throw notFound('Semester not found');
    return semester;
}

// An Exam Week is set or withdrawn while its Semester still takes grades: OPEN or
// FINALIZING, in an ACTIVE year.
function assertSemesterTakesExamWeeks(semester) {
    if (semester.status === 'CLOSED') throw conflict(`Semester ${semester.ordinal} is closed`);
    if (semester.academicYear.status !== 'ACTIVE') {
        throw conflict(`Academic year ${semester.academicYear.label} is closed`);
    }
}

// Every grade level named exists at this school's type: there is no grade 10 at an SMP.
async function assertGradesExist(auth, gradeLevels) {
    const school = await prisma.school.findUnique({
        where: { id: auth.schoolId },
        select: { schoolType: true, durationYears: true },
    });
    const missing = gradeLevels.filter((grade) => !isValidGrade(school.schoolType, grade, school.durationYears));
    if (missing.length) {
        throw badRequest(`This ${school.schoolType} has no grade ${missing.join(', ')}`, { gradeLevels: missing });
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// A Semester's Exam Weeks still standing, oldest first. Every ACTIVE member reads
// them; another school's Semester is not found.
async function listExamWeeks(auth, { semesterId }) {
    await loadSemester(semesterId);
    const rows = await prisma.examWeek.findMany({
        where: { semesterId, withdrawnAt: null },
        orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(examWeekView);
}

// The Exam Weeks standing on any day of a year, for the school's calendar
// (GET /api/holidays?year=).
async function examWeeksOfYear(year) {
    const rows = await prisma.examWeek.findMany({
        where: {
            withdrawnAt: null,
            startDate: { lte: toDate(`${year}-12-31`) },
            endDate: { gte: toDate(`${year}-01-01`) },
        },
        orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(examWeekView);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// The Principal or a Vice Principal sets one. Refused: days outside the Semester or
// a grade level the school lacks (400), a closed Semester or year, and an overlap
// with one standing on a shared grade level (409). Audited in the same transaction;
// the Sessions follow once it is committed.
async function addExamWeek(auth, { semesterId, type, name, startDate, endDate, gradeLevels }) {
    await assertPrincipalOrVice(auth);
    const semester = await loadSemester(semesterId);
    assertSemesterTakesExamWeeks(semester);
    const [first, last] = [toDay(semester.startDate), toDay(semester.endDate)];
    if (startDate < first || endDate > last) {
        throw badRequest(`An Exam Week lies inside Semester ${semester.ordinal}: ${first} to ${last}`);
    }
    await assertGradesExist(auth, gradeLevels);

    let created;
    try {
        created = await prisma.$transaction(
            async (tx) => {
                const clash = await tx.examWeek.findFirst({
                    where: {
                        semesterId,
                        withdrawnAt: null,
                        gradeLevels: { hasSome: gradeLevels },
                        startDate: { lte: toDate(endDate) },
                        endDate: { gte: toDate(startDate) },
                    },
                });
                if (clash) {
                    const shared = clash.gradeLevels.filter((grade) => gradeLevels.includes(grade));
                    throw conflict(
                        `It overlaps ${clash.type} "${clash.name}" (${describeDays(clash)}) ` +
                            `on grade ${shared.join(', ')}`,
                        { examWeekId: clash.id }
                    );
                }

                const row = await tx.examWeek.create({
                    data: {
                        semesterId,
                        type,
                        name,
                        startDate: toDate(startDate),
                        endDate: toDate(endDate),
                        gradeLevels: [...gradeLevels].sort((a, b) => a - b),
                        createdByUserId: auth.userId,
                    },
                });
                await recordAudit({
                    schoolId: auth.schoolId,
                    subjectType: EXAM_WEEK_SUBJECT,
                    subjectId: row.id,
                    action: 'APPROVE',
                    actorUserId: auth.userId,
                    client: tx,
                });
                return row;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
    } catch (error) {
        if (error?.code !== 'P2034') throw error;
        throw conflict(SET_AT_ONCE);
    }

    await onCalendarChanged([auth.schoolId], daysBetween(startDate, endDate), {
        semesterId,
        gradeLevels: created.gradeLevels,
    });

    log.info(
        `Exam Week added at ${auth.schoolName}: ${type} ${startDate}..${endDate} ` +
            `grade ${created.gradeLevels.join(', ')} ${name}`
    );
    return examWeekView(created);
}

// The Principal or a Vice Principal withdraws one still standing. A UTS or a UAS
// published inside it keeps its window (owner, 2026-10-18). Its days from tomorrow
// are taught again, unless a holiday or another cause keeps them away.
async function withdrawExamWeek(auth, id) {
    await assertPrincipalOrVice(auth);
    const row = await prisma.examWeek.findFirst({ where: { id, withdrawnAt: null } });
    // Another school's, an unknown id, or one already withdrawn: one answer.
    if (!row) throw notFound('No Exam Week of yours stands under that id');
    assertSemesterTakesExamWeeks(await loadSemester(row.semesterId));

    await prisma.$transaction(async (tx) => {
        const claimed = await tx.examWeek.updateMany({
            where: { id, withdrawnAt: null },
            data: { withdrawnAt: new Date(), withdrawnByUserId: auth.userId },
        });
        if (claimed.count === 0) throw notFound('No Exam Week of yours stands under that id');

        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: EXAM_WEEK_SUBJECT,
            subjectId: id,
            action: 'WITHDRAW',
            actorUserId: auth.userId,
            client: tx,
        });
    });

    await onCalendarChanged([auth.schoolId], daysBetween(toDay(row.startDate), toDay(row.endDate)), {
        semesterId: row.semesterId,
        gradeLevels: row.gradeLevels,
    });

    const withdrawn = await prisma.examWeek.findFirst({ where: { id } });
    log.info(`Exam Week withdrawn at ${auth.schoolName}: ${row.type} ${describeDays(row)} ${row.name}`);
    return examWeekView(withdrawn);
}

export { listExamWeeks, examWeeksOfYear, addExamWeek, withdrawExamWeek };
