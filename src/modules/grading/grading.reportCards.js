import { prisma } from '../../shared/prisma.js';
import { isPrincipalOrVice } from '../../shared/guards.js';
import { notFound } from '../../shared/errors.js';
import { getStorage } from '../../shared/storage.js';
import { createLogger } from '../../lib/helpers.js';
import { toDay } from '../holidays/holidays.calendar.js';
import { TYPES, LETTER_SCALE, letterOf } from './grading.compute.js';
import { AVERAGE_COLUMNS } from './grading.close.js';
import { renderReportCard } from './grading.pdf.js';

const log = createLogger('Grading');

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
// - After a reopen (ticket 06) the next close writes a new version. A Student reads only
//   the newest; the staff read the earlier ones too, and their views name every version
//   they may open (owner, 2026-10-19). A version is in the Class it was closed in, so a
//   Student who moved Class between two closes is listed in their newest version's Class.
// - Each version prints as a PDF (ticket 07, grading.pdf.js), rendered on request from
//   the frozen row and never stored, for exactly the readers of its JSON (owner,
//   2026-10-20).
// - Each Subject carries its four type averages as frozen, and the letter of its Final
//   Grade, from the one fixed scale the view names too; the view says which blank tables
//   the School chose at close (ticket 08, owner 2026-10-20).
// - An even Semester's carries the year's Promotion Outcome and the grade level it leads
//   to (ticket 09); an odd one's null.
// - The School's address and phone as at close, and whether it had a logo (ticket 10).
//   The logo's file is read only to print it, and its key never leaves the server; a
//   file gone from storage prints without it, and the log says so.

const NOT_FOUND = 'Report card not found';

const reportCardSelect = {
    id: true,
    semesterId: true,
    studentProfileId: true,
    version: true,
    classId: true,
    reportDate: true,
    schoolName: true,
    schoolNpsn: true,
    schoolCity: true,
    schoolAddress: true,
    schoolPhone: true,
    schoolLogoKey: true,
    studentName: true,
    nisn: true,
    className: true,
    phase: true,
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
    extracurricularTable: true,
    personalityTable: true,
    promotionOutcome: true,
    nextGradeLevel: true,
    createdAt: true,
    subjects: {
        select: {
            subjectId: true,
            subjectCode: true,
            subjectName: true,
            finalGrade: true,
            kktp: true,
            averageTugas: true,
            averageKuis: true,
            averageUts: true,
            averageUas: true,
            description: true,
        },
        orderBy: { position: 'asc' },
    },
};

// A Report Card as it was written: the date the Principal chose as a calendar day, and
// writtenAt the moment the Semester closed. The NPSN, the city and the phase are null on
// one written before ticket 07; the type averages on one written before ticket 08, and
// it has no blank table.
const reportCardView = (row) => ({
    id: row.id,
    version: row.version,
    reportDate: toDay(row.reportDate),
    writtenAt: row.createdAt,
    school: {
        name: row.schoolName,
        npsn: row.schoolNpsn,
        city: row.schoolCity,
        address: row.schoolAddress,
        phone: row.schoolPhone,
        hasLogo: row.schoolLogoKey !== null,
    },
    academicYear: row.academicYearLabel,
    semester: { id: row.semesterId, ordinal: row.semesterOrdinal },
    student: { studentProfileId: row.studentProfileId, fullName: row.studentName, nisn: row.nisn },
    class: { id: row.classId, name: row.className },
    phase: row.phase,
    homeroomTeacher:
        row.homeroomTeacherName === null ? null : { fullName: row.homeroomTeacherName, nip: row.homeroomTeacherNip },
    principal: { fullName: row.principalName, nip: row.principalNip },
    subjects: row.subjects.map((line) => ({
        subject: { id: line.subjectId, code: line.subjectCode, name: line.subjectName },
        types: Object.fromEntries(TYPES.map((type) => [type, line[AVERAGE_COLUMNS[type]]])),
        finalGrade: line.finalGrade,
        kktp: line.kktp,
        letter: letterOf(line.finalGrade),
        description: line.description,
    })),
    attendance: { sick: row.sick, excused: row.excused, absent: row.absent },
    note: row.note,
    blankTables: { extracurricular: row.extracurricularTable, personality: row.personalityTable },
    letterScale: LETTER_SCALE,
    promotion: row.promotionOutcome ? { outcome: row.promotionOutcome, nextGradeLevel: row.nextGradeLevel } : null,
});

const versionSelect = {
    id: true,
    studentProfileId: true,
    classId: true,
    version: true,
    reportDate: true,
    createdAt: true,
};

// One version as a staff reader's list names it.
const versionView = (row) => ({
    id: row.id,
    version: row.version,
    reportDate: toDay(row.reportDate),
    writtenAt: row.createdAt,
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

// Of these rows, one Semester's, every version of a Student's Report Card that the
// reader opens, the oldest first.
const versionsOf = (rows, studentProfileId, opens) =>
    rows
        .filter((row) => row.studentProfileId === studentProfileId && opens(row))
        .sort((a, b) => a.version - b.version)
        .map(versionView);

// The caller's own live Student profile, or null.
const ownProfileOf = (auth) =>
    prisma.studentProfile.findFirst({
        where: { membershipId: auth.membershipId, endedAt: null },
        select: { id: true },
    });

// Which Report Cards a staff reader opens, as a test on a row's classId: every one for
// the Principal and the Vice Principals, those of the Classes a Homeroom Teacher leads.
// Null for anyone else.
async function staffOpenerOf(auth) {
    if (await isPrincipalOrVice(auth.membershipId)) return () => true;
    const led = await prisma.class.findMany({
        where: { homeroomTeacherMembershipId: auth.membershipId },
        select: { id: true },
    });
    if (led.length === 0) return null;
    const classIds = new Set(led.map((row) => row.id));
    return (row) => classIds.has(row.classId);
}

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

// One Report Card as its reader may open it: its Student - the newest of theirs only -
// the Homeroom Teacher of its Class, the Principal and the Vice Principals; anyone else
// gets 404. Answers the row, and the staff reader's test (staffOpenerOf), null for its
// Student. The one rule behind its JSON and its PDF.
async function loadReadable(auth, id) {
    const row = await prisma.reportCard.findFirst({ where: { id }, select: reportCardSelect });
    if (!row) throw notFound(NOT_FOUND);
    const opens = await staffOpenerOf(auth);
    if (opens?.(row)) return { row, opens };

    const profile = await ownProfileOf(auth);
    if (profile?.id !== row.studentProfileId) throw notFound(NOT_FOUND);
    const newer = await prisma.reportCard.count({
        where: { semesterId: row.semesterId, studentProfileId: row.studentProfileId, version: { gt: row.version } },
    });
    if (newer > 0) throw notFound(NOT_FOUND);
    return { row, opens: null };
}

// One Report Card, as loadReadable allows. The staff's view names every version of it
// they may open (ticket 06).
async function readReportCard(auth, id) {
    const { row, opens } = await loadReadable(auth, id);
    if (!opens) return reportCardView(row);
    const versions = await prisma.reportCard.findMany({
        where: { semesterId: row.semesterId, studentProfileId: row.studentProfileId },
        select: versionSelect,
    });
    return { ...reportCardView(row), versions: versionsOf(versions, row.studentProfileId, opens) };
}

// One Report Card printed (ticket 07), as loadReadable allows: its PDF and a file name
// that says whose, which Semester and which version, as 'Rapor-Andi-2026-2027-Semester-1-v2.pdf'.
async function reportCardPdf(auth, id) {
    const { row } = await loadReadable(auth, id);
    const view = reportCardView(row);
    const words = [view.student.fullName, view.academicYear, `Semester ${view.semester.ordinal}`];
    const name = words.join(' ').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    const logo = await logoOf(row);
    return { buffer: await renderReportCard(view, { logo }), fileName: `Rapor-${name}-v${view.version}.pdf` };
}

// The logo frozen on a Report Card (ticket 10), its bytes, or null: none was frozen, or
// its file is gone from storage - it then prints without one rather than not at all.
async function logoOf(row) {
    if (!row.schoolLogoKey) return null;
    try {
        return await getStorage().read(row.schoolLogoKey);
    } catch (error) {
        log.warn(`Report Card ${row.id} printed without its logo: ${error.code ?? error.message}`);
        return null;
    }
}

// The Report Cards of a Class for one Semester of its year - the newest of each Student
// whose newest was closed in it, by name, each naming its versions - for its Homeroom
// Teacher, the Principal and the Vice Principals. Anyone else, and a Semester of another
// year, gets 404. One who moved to another Class before a later close is listed there
// (ticket 06, owner 2026-10-19), not here with an older version.
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
    const opens = await staffOpenerOf(auth);
    if (!opens?.({ classId: homeroom.id })) throw notFound('Class not found');
    if (!semester || semester.academicYearId !== homeroom.academicYearId) throw notFound('Semester not found');

    const closedHere = await prisma.reportCard.findMany({
        where: { classId: homeroom.id, semesterId: semester.id },
        select: { studentProfileId: true },
        distinct: ['studentProfileId'],
    });
    const rows = await prisma.reportCard.findMany({
        where: { semesterId: semester.id, studentProfileId: { in: closedHere.map((row) => row.studentProfileId) } },
        select: reportCardSelect,
    });
    return {
        class: { id: homeroom.id, name: homeroom.name },
        academicYear: homeroom.academicYear.label,
        semester: { id: semester.id, ordinal: semester.ordinal, status: semester.status },
        reportCards: newestOf(rows)
            .filter((row) => row.classId === homeroom.id)
            .sort((a, b) => a.studentName.localeCompare(b.studentName))
            .map((row) => ({ ...reportCardView(row), versions: versionsOf(rows, row.studentProfileId, opens) })),
    };
}

export { myReportCards, readReportCard, reportCardPdf, classReportCards };
