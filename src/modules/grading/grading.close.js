import { prisma } from '../../shared/prisma.js';
import { recordAudit } from '../../shared/approval.js';
import { badRequest, conflict } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { semesterSpan, todayOf } from '../sessions/sessions.service.js';
import { attendanceCounts } from '../attendance/attendance.service.js';
import { toDate, toDay } from '../holidays/holidays.calendar.js';
import { classSubjectSelect, describe } from './grading.service.js';
import { gradeBookOf } from './grading.grades.js';
import { blockersOf } from './grading.readiness.js';
import { reportCardHoldersOf } from './grading.reporting.js';
import { LIVE_FINALISATION } from './grading.lock.js';
import {
    SEMESTER_SUBJECT,
    SLOTS_AT_ONCE,
    mapAtMost,
    loadSemester,
    assertYearActive,
    assertPrincipal,
    semesterName,
    semesterView,
    orderedSlotsOf,
} from './grading.finalising.js';

const log = createLogger('Grading');

// Closing a Semester (grading-and-report-card ticket 05), the second of its two steps
// (handoff #28): the Principal closes it, FINALIZING -> CLOSED, and every Student's
// Report Card is written in the same transaction, all or none, and never recomputed.
// It reads Scores and writes none (spec invariant 2).
//
// Owner's decisions (2026-10-13, the spec, and the plan of 2026-10-19):
// - The Principal's alone (ADR-0009): a Vice Principal is told no. Audited
//   CLOSE_SEMESTER against the Semester.
// - Allowed only on or after the Semester's last day (registration-and-membership 24's
//   rule, by todayOf), with every slot finalised, nothing blocking any of them - read
//   again as the readiness board reads them, so a Class Move since a slot was finalised
//   shows - and every Note written. One 409 names all of it.
// - The Principal chooses the Report Card's date: from the Semester's first day to 30
//   days after its last, so it may be printed ahead of the day it is handed out.
// - Who gets one is grading.reporting.js's reportCardHoldersOf. A Student with no
//   Subject at all gets one too, with their attendance and the Note.
// - What it holds: the Class at close and its Homeroom Teacher; per Subject the Final
//   Grade (ticket 02), computed with the settings the slot was finalised with, its KKTP
//   and its Description; the Sessions Sick, Excused and Absent, confirmed ones only, in
//   any Class (attendanceSummary's rule); and the Note. The names it shows are copied,
//   the Principal's and both NIPs too, so a rename later changes none of it.
// - Every Subject on it has a grade: a Student without one blocks their slot
//   (grading.readiness.js's NO_GRADE).
// - The grades are computed before the transaction, a few slots at a time - 450 slots
//   take about 14 s, past what an interactive transaction allows by default. Inside
//   it, after the Semester is claimed, the finalisations, the placements and the Notes
//   are read again: one changed meanwhile refuses the close, and nothing is written.

// The national catalog's Subjects in the order it was written in (migration
// _national_subject_catalog), the order a Report Card lists them (owner, 2026-10-19).
// The school's own Subjects follow, by name.
const NATIONAL_ORDER = [
    'PAI',
    'PPKN',
    'BIND',
    'MTK',
    'IPAS',
    'IPA',
    'IPS',
    'BING',
    'PJOK',
    'SENI',
    'INFO',
    'PKWU',
    'SEJ',
    'FIS',
    'KIM',
    'BIO',
    'EKO',
    'GEO',
];

// A Report Card may be dated up to this many days after its Semester's last day.
const DATE_GRACE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

// Writing a whole school's Report Cards outlasts Prisma's 5 s default.
const WRITE_TIMEOUT_MS = 30_000;

// A 409's text names at most this many of each kind; its details name them all.
const NAMED_IN_TEXT = 5;

const CHANGED_MEANWHILE = 'changed while it was being closed. Try again';

const slotKeyOf = (row) => `${row.classId}:${row.subjectId}`;

const slotRef = (classSubject) => ({
    classSubjectId: classSubject.id,
    class: { id: classSubject.classId, name: classSubject.class.name },
    subject: { id: classSubject.subjectId, code: classSubject.subject.code, name: classSubject.subject.name },
});

// 'MTK in 7A, IPA in 7A and 3 more'.
function someOf(texts) {
    const named = texts.slice(0, NAMED_IN_TEXT).join(', ');
    return texts.length > NAMED_IN_TEXT ? `${named} and ${texts.length - NAMED_IN_TEXT} more` : named;
}

// ---------------------------------------------------------------------------
// Before closing
// ---------------------------------------------------------------------------

// Refuses (409) a Semester before its last day, the school's local date.
async function assertLastDayCome(auth, semester) {
    const lastDay = toDay(semester.endDate);
    if ((await todayOf(auth.schoolId)) >= lastDay) return;
    throw conflict(`${semesterName(semester)} runs until ${lastDay}; it closes on its last day or after`, {
        endDate: lastDay,
    });
}

// Refuses (400) a date outside the Semester's first day to 30 days after its last.
function assertReportDate(semester, reportDate) {
    const first = toDay(semester.startDate);
    const last = toDay(new Date(semester.endDate.getTime() + DATE_GRACE_DAYS * DAY_MS));
    if (reportDate >= first && reportDate <= last) return;
    throw badRequest(`Date the Report Cards from ${first} to ${last}`, { from: first, to: last });
}

// One finalised slot as a Report Card takes it: what still blocks it, and the grade of
// each Student it reports who gets a Report Card. The book itself is let go.
async function closingSlotOf(auth, classSubject, holders) {
    const book = await gradeBookOf(auth, classSubject);
    const blockers = await blockersOf(book);
    const reported = book.roster.studentProfileIds.filter(
        (studentProfileId) => book.reporting.isReportedHere(studentProfileId) && holders.has(studentProfileId)
    );
    const lines = reported.map((studentProfileId) => ({
        studentProfileId,
        subjectId: classSubject.subjectId,
        classId: classSubject.classId,
        finalGrade: book.gradeOf(studentProfileId).finalGrade?.value ?? null,
        kktp: book.settings.kktp.value,
        description: book.descriptions.descriptionOf(studentProfileId)?.text ?? null,
    }));
    return { classSubject, blockers, lines };
}

// Everything a close needs, read once before its transaction: the slots and their
// finalisations, who gets a Report Card and where they sit now, the finalised slots'
// grades, and the Notes. Also what stops it, if anything.
async function closingReadOf(auth, semester) {
    const span = await semesterSpan(auth.schoolId, semester);
    const [classSubjects, holders, finalisations] = await Promise.all([
        prisma.classSubject.findMany({
            where: { semesterId: semester.id, status: 'ACTIVE' },
            select: classSubjectSelect,
        }),
        reportCardHoldersOf(semester.academicYearId, span),
        prisma.slotFinalisation.findMany({
            where: { semesterId: semester.id, ...LIVE_FINALISATION },
            select: { classId: true, subjectId: true },
        }),
    ]);
    const finalised = new Set(finalisations.map(slotKeyOf));
    const slots = orderedSlotsOf(classSubjects);
    const notFinalised = slots.filter((classSubject) => !finalised.has(slotKeyOf(classSubject)));
    const closing = await mapAtMost(
        slots.filter((classSubject) => finalised.has(slotKeyOf(classSubject))),
        SLOTS_AT_ONCE,
        (classSubject) => closingSlotOf(auth, classSubject, holders)
    );
    const notes = await prisma.homeroomNote.findMany({
        where: { semesterId: semester.id, studentProfileId: { in: [...holders.keys()] }, text: { not: null } },
        select: { studentProfileId: true, text: true },
    });
    return {
        span,
        holders,
        finalised,
        notFinalised,
        blocked: closing.filter((slot) => slot.blockers.length > 0),
        lines: closing.flatMap((slot) => slot.lines),
        noteOf: new Map(notes.map((row) => [row.studentProfileId, row.text])),
    };
}

// Refuses (409) a close that something still stops, naming all of it: the slots not
// finalised, the finalised ones something blocks, and the Students without a Note.
async function assertClosable(semester, read) {
    const missing = [...read.holders].filter(([studentProfileId]) => !read.noteOf.has(studentProfileId));
    if (read.notFinalised.length === 0 && read.blocked.length === 0 && missing.length === 0) return;

    const [profiles, classes] = await Promise.all([
        prisma.studentProfile.findMany({
            where: { id: { in: missing.map(([studentProfileId]) => studentProfileId) } },
            select: { id: true, membership: { select: { user: { select: { fullName: true } } } } },
        }),
        prisma.class.findMany({
            where: { id: { in: [...new Set(missing.map(([, classId]) => classId))] } },
            select: { id: true, name: true },
        }),
    ]);
    const nameOf = new Map(profiles.map((row) => [row.id, row.membership.user.fullName]));
    const classOf = new Map(classes.map((row) => [row.id, row]));
    const notesMissing = missing.map(([studentProfileId, classId]) => ({
        studentProfileId,
        fullName: nameOf.get(studentProfileId) ?? null,
        class: classOf.get(classId),
    }));

    const parts = [];
    if (read.notFinalised.length) {
        parts.push(`not finalised: ${someOf(read.notFinalised.map((classSubject) => describe(classSubject)))}`);
    }
    for (const { classSubject, blockers } of read.blocked.slice(0, NAMED_IN_TEXT)) {
        parts.push(`${describe(classSubject)}: ${blockers.map((blocker) => blocker.text).join('; ')}`);
    }
    if (read.blocked.length > NAMED_IN_TEXT) parts.push(`${read.blocked.length - NAMED_IN_TEXT} more blocked`);
    if (notesMissing.length) {
        const whose = notesMissing.map((row) => `${row.fullName ?? 'a student'} in ${row.class.name}`);
        parts.push(`no Homeroom Teacher's note for ${someOf(whose)}`);
    }
    throw conflict(`${semesterName(semester)} cannot be closed yet: ${parts.join('; ')}`, {
        notFinalised: read.notFinalised.map(slotRef),
        blocked: read.blocked.map(({ classSubject, blockers }) => ({ ...slotRef(classSubject), blockers })),
        notesMissing,
    });
}

// ---------------------------------------------------------------------------
// The Report Cards
// ---------------------------------------------------------------------------

// Each Subject's place on a Report Card: the national ones in the catalog's order, the
// rest - the school's own, or a national one added since - after them by name.
function positionsOf(subjects) {
    const rank = (subject) => (subject.schoolId === null ? NATIONAL_ORDER.indexOf(subject.code) : -1);
    const national = subjects.filter((subject) => rank(subject) >= 0).sort((a, b) => rank(a) - rank(b));
    const own = subjects.filter((subject) => rank(subject) < 0).sort((a, b) => a.name.localeCompare(b.name));
    return new Map([...national, ...own].map((subject, index) => [subject.id, index + 1]));
}

const nipOf = (membership) => membership?.teacherProfile?.nip ?? null;

// The rows a close writes - a Report Card per Student who gets one, and a line per
// Subject on it - with the names they show copied as they read now.
async function reportCardRowsOf(auth, semester, reportDate, read) {
    const studentProfileIds = [...read.holders.keys()];
    const [school, principal, students, classes, subjects, attendance] = await Promise.all([
        prisma.school.findFirst({ where: { id: auth.schoolId }, select: { name: true } }),
        prisma.schoolMembership.findFirst({
            where: { id: auth.membershipId },
            select: { user: { select: { fullName: true } }, teacherProfile: { select: { nip: true } } },
        }),
        prisma.studentProfile.findMany({
            where: { id: { in: studentProfileIds } },
            select: { id: true, nisn: true, membership: { select: { user: { select: { fullName: true } } } } },
        }),
        prisma.class.findMany({
            where: { id: { in: [...new Set(read.holders.values())] } },
            select: {
                id: true,
                name: true,
                homeroomTeacher: {
                    select: { user: { select: { fullName: true } }, teacherProfile: { select: { nip: true } } },
                },
            },
        }),
        prisma.subject.findMany({
            where: { id: { in: [...new Set(read.lines.map((line) => line.subjectId))] } },
            select: { id: true, code: true, name: true, schoolId: true },
        }),
        attendanceCounts(studentProfileIds, { classSubject: { semesterId: semester.id } }),
    ]);
    const studentOf = new Map(students.map((row) => [row.id, row]));
    const classOf = new Map(classes.map((row) => [row.id, row]));
    const subjectOf = new Map(subjects.map((row) => [row.id, row]));
    const positionOf = positionsOf(subjects);

    const cards = [...read.holders].map(([studentProfileId, classId]) => {
        const student = studentOf.get(studentProfileId);
        const homeroom = classOf.get(classId);
        const counts = attendance.get(studentProfileId);
        return {
            semesterId: semester.id,
            studentProfileId,
            // The first close's; a reopen's next close writes the next (ticket 06).
            version: 1,
            classId,
            reportDate: toDate(reportDate),
            schoolName: school.name,
            studentName: student.membership.user.fullName,
            nisn: student.nisn,
            className: homeroom.name,
            academicYearLabel: semester.academicYear.label,
            semesterOrdinal: semester.ordinal,
            homeroomTeacherName: homeroom.homeroomTeacher?.user.fullName ?? null,
            homeroomTeacherNip: nipOf(homeroom.homeroomTeacher),
            principalName: principal.user.fullName,
            principalNip: nipOf(principal),
            sick: counts.sick,
            excused: counts.excused,
            absent: counts.absent,
            note: read.noteOf.get(studentProfileId),
            closedByUserId: auth.userId,
        };
    });
    const lines = read.lines.map((line) => ({
        ...line,
        position: positionOf.get(line.subjectId),
        subjectCode: subjectOf.get(line.subjectId).code,
        subjectName: subjectOf.get(line.subjectId).name,
    }));
    return { cards, lines };
}

// Inside the close's transaction, after the Semester is claimed: refuses (409) a close
// whose slots, placements or Notes changed since they were read - a finalising undone,
// a Class Move, a Note cleared - so nothing is written on what no longer holds.
async function assertUnchanged(tx, semester, read) {
    const [finalisations, holders, notes] = await Promise.all([
        tx.slotFinalisation.findMany({
            where: { semesterId: semester.id, ...LIVE_FINALISATION },
            select: { classId: true, subjectId: true },
        }),
        reportCardHoldersOf(semester.academicYearId, read.span, null, tx),
        tx.homeroomNote.findMany({
            where: { semesterId: semester.id, studentProfileId: { in: [...read.holders.keys()] }, text: { not: null } },
            select: { studentProfileId: true, text: true },
        }),
    ]);
    const sameSlots =
        finalisations.length === read.finalised.size &&
        finalisations.every((row) => read.finalised.has(slotKeyOf(row)));
    const samePlaces =
        holders.size === read.holders.size &&
        [...holders].every(([studentProfileId, classId]) => read.holders.get(studentProfileId) === classId);
    const sameNotes =
        notes.length === read.noteOf.size && notes.every((row) => read.noteOf.get(row.studentProfileId) === row.text);
    if (!sameSlots) throw conflict(`The finalised class subjects of ${semesterName(semester)} ${CHANGED_MEANWHILE}`);
    if (!samePlaces) throw conflict(`The placements in ${semesterName(semester)} ${CHANGED_MEANWHILE}`);
    if (!sameNotes) throw conflict(`The Homeroom Teachers' notes of ${semesterName(semester)} ${CHANGED_MEANWHILE}`);
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

// The Principal closes a FINALIZING Semester on or after its last day, dating its
// Report Cards; a Vice Principal is told no (403). Refused with 409 while a slot is not
// finalised, something blocks one, or a Note is missing, naming all of it; with 400 for
// a date out of range. Writes every Report Card, the Semester CLOSED and the audit in
// one transaction. Answers with the Semester and how many were written.
async function closeSemester(auth, id, { reportDate }) {
    await assertPrincipal(auth, 'closes a semester');
    const semester = await loadSemester(id);
    assertYearActive(semester);
    if (semester.status !== 'FINALIZING') {
        throw conflict(
            semester.status === 'OPEN'
                ? `${semesterName(semester)} is not being finalised; the Principal starts finalising first`
                : `${semesterName(semester)} is closed already`
        );
    }
    await assertLastDayCome(auth, semester);
    assertReportDate(semester, reportDate);

    const read = await closingReadOf(auth, semester);
    await assertClosable(semester, read);
    const { cards, lines } = await reportCardRowsOf(auth, semester, reportDate, read);

    await prisma.$transaction(
        async (tx) => {
            const claimed = await tx.semester.updateMany({
                where: { id: semester.id, status: 'FINALIZING' },
                data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: auth.userId },
            });
            if (claimed.count === 0) throw conflict(`${semesterName(semester)} is no longer being finalised`);
            await assertUnchanged(tx, semester, read);

            const written = await tx.reportCard.createManyAndReturn({
                data: cards,
                select: { id: true, studentProfileId: true },
            });
            const cardOf = new Map(written.map((row) => [row.studentProfileId, row.id]));
            await tx.reportCardSubject.createMany({
                data: lines.map(({ studentProfileId, ...line }) => ({
                    reportCardId: cardOf.get(studentProfileId),
                    ...line,
                })),
            });
            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: SEMESTER_SUBJECT,
                subjectId: semester.id,
                action: 'CLOSE_SEMESTER',
                actorUserId: auth.userId,
                reason: `Report Cards dated ${reportDate}: ${cards.length} written`,
                client: tx,
            });
        },
        { timeout: WRITE_TIMEOUT_MS }
    );

    log.info(`${semesterName(semester)} closed: ${cards.length} Report Card(s) dated ${reportDate}`);
    return { semester: semesterView(await loadSemester(id)), reportDate, reportCards: cards.length };
}

export { closeSemester };
