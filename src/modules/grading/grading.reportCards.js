import { prisma } from '../../shared/prisma.js';
import { isPrincipalOrVice, isHomeroomOf } from '../../shared/guards.js';
import { notFound } from '../../shared/errors.js';
import { toDay } from '../holidays/holidays.calendar.js';

// Reading Report Cards (grading-and-report-card ticket 05), written frozen by the close
// (grading.close.js) and read as they were written.
//
// Owner's decisions (2026-10-13, the spec, and the plan of 2026-10-19):
// - A Student reads their own, the newest version of each Semester's, and nothing of
//   anyone else's (spec invariant 6). Before their Semester closes there is none to
//   read.
// - The Homeroom Teacher of a Class - whoever it is now - reads the Report Cards of the
//   Students who were placed in it at close. The Principal and the Vice Principals read
//   every one.
// - A Guardian reads none yet (the guardian-view spec).
// - Anyone else, another school's member included, gets the same 404 as a missing one.
// - Ticket 06 writes later versions; the staff will read those, a Student only the
//   newest.

const NOT_FOUND = 'Report card not found';

const reportCardSelect = {
    id: true,
    semesterId: true,
    studentProfileId: true,
    version: true,
    classId: true,
    reportDate: true,
    schoolName: true,
    studentName: true,
    nisn: true,
    className: true,
    academicYearLabel: true,
    semesterOrdinal: true,
    homeroomTeacherName: true,
    homeroomTeacherNip: true,
    principalName: true,
    principalNip: true,
    sick: true,
    excused: true,
    absent: true,
    note: true,
    createdAt: true,
    subjects: {
        select: {
            subjectId: true,
            subjectCode: true,
            subjectName: true,
            finalGrade: true,
            kktp: true,
            description: true,
        },
        orderBy: { position: 'asc' },
    },
};

// A Report Card as it was written: the date the Principal chose as a calendar day, and
// writtenAt the moment the Semester closed.
const reportCardView = (row) => ({
    id: row.id,
    version: row.version,
    reportDate: toDay(row.reportDate),
    writtenAt: row.createdAt,
    school: { name: row.schoolName },
    academicYear: row.academicYearLabel,
    semester: { id: row.semesterId, ordinal: row.semesterOrdinal },
    student: { studentProfileId: row.studentProfileId, fullName: row.studentName, nisn: row.nisn },
    class: { id: row.classId, name: row.className },
    homeroomTeacher:
        row.homeroomTeacherName === null ? null : { fullName: row.homeroomTeacherName, nip: row.homeroomTeacherNip },
    principal: { fullName: row.principalName, nip: row.principalNip },
    subjects: row.subjects.map((line) => ({
        subject: { id: line.subjectId, code: line.subjectCode, name: line.subjectName },
        finalGrade: line.finalGrade,
        kktp: line.kktp,
        description: line.description,
    })),
    attendance: { sick: row.sick, excused: row.excused, absent: row.absent },
    note: row.note,
});

// Of these rows, the newest version of each Student's Report Card for each Semester.
function newestOf(rows) {
    const newest = new Map();
    for (const row of rows) {
        const key = `${row.semesterId}:${row.studentProfileId}`;
        if (!newest.has(key) || newest.get(key).version < row.version) newest.set(key, row);
    }
    return [...newest.values()];
}

// The caller's own live Student profile, or null.
const ownProfileOf = (auth) =>
    prisma.studentProfile.findFirst({
        where: { membershipId: auth.membershipId, endedAt: null },
        select: { id: true },
    });

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// A Student's own Report Cards, the newest of each Semester's, the latest Semester first.
// None before their first Semester closes.
async function myReportCards(auth) {
    const profile = await ownProfileOf(auth);
    if (!profile) return [];
    const rows = await prisma.reportCard.findMany({
        where: { studentProfileId: profile.id },
        select: { ...reportCardSelect, semester: { select: { startDate: true } } },
    });
    return newestOf(rows)
        .sort((a, b) => b.semester.startDate - a.semester.startDate)
        .map(reportCardView);
}

// One Report Card: for its Student - the newest of theirs only - the Homeroom Teacher
// of its Class, the Principal and the Vice Principals; anyone else gets 404.
async function readReportCard(auth, id) {
    const row = await prisma.reportCard.findFirst({ where: { id }, select: reportCardSelect });
    if (!row) throw notFound(NOT_FOUND);
    if (await isPrincipalOrVice(auth.membershipId)) return reportCardView(row);
    if (await isHomeroomOf(auth.membershipId, row.classId)) return reportCardView(row);

    const profile = await ownProfileOf(auth);
    if (profile?.id !== row.studentProfileId) throw notFound(NOT_FOUND);
    const newer = await prisma.reportCard.count({
        where: { semesterId: row.semesterId, studentProfileId: row.studentProfileId, version: { gt: row.version } },
    });
    if (newer > 0) throw notFound(NOT_FOUND);
    return reportCardView(row);
}

// The Report Cards of a Class for one Semester of its year - the newest of each Student
// placed in it at close, by name - for its Homeroom Teacher, the Principal and the Vice
// Principals. Anyone else, and a Semester of another year, gets 404.
async function classReportCards(auth, classId, semesterId) {
    const [homeroom, semester] = await Promise.all([
        prisma.class.findFirst({
            where: { id: classId },
            select: { id: true, name: true, academicYearId: true, academicYear: { select: { label: true } } },
        }),
        prisma.semester.findFirst({
            where: { id: semesterId },
            select: { id: true, ordinal: true, status: true, academicYearId: true },
        }),
    ]);
    if (!homeroom) throw notFound('Class not found');
    const reads =
        (await isHomeroomOf(auth.membershipId, homeroom.id)) || (await isPrincipalOrVice(auth.membershipId));
    if (!reads) throw notFound('Class not found');
    if (!semester || semester.academicYearId !== homeroom.academicYearId) throw notFound('Semester not found');

    const rows = await prisma.reportCard.findMany({
        where: { classId: homeroom.id, semesterId: semester.id },
        select: reportCardSelect,
    });
    return {
        class: { id: homeroom.id, name: homeroom.name },
        academicYear: homeroom.academicYear.label,
        semester: { id: semester.id, ordinal: semester.ordinal, status: semester.status },
        reportCards: newestOf(rows)
            .sort((a, b) => a.studentName.localeCompare(b.studentName))
            .map(reportCardView),
    };
}

export { myReportCards, readReportCard, classReportCards };
