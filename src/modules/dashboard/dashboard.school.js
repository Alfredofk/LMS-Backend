import { prisma } from '../../shared/prisma.js';
import { assertPrincipalOrVice } from '../../shared/guards.js';
import { notFound } from '../../shared/errors.js';
import { currentTermOf } from '../academics/academics.term.js';
import { percentOf } from './dashboard.service.js';

// The Principal's and the Vice Principals' aggregate (dashboard ticket 06, the spec's D3, D6
// and D8): the School seen whole, as of the nightly rollup (dashboard.rollup.js), in two
// lists, per Class and per Subject per grade level, under one line for the School. Nothing is
// counted live per slot.
//
// Owner's decisions (2026-10-26, the spec; 2026-10-28, the plan, through the picker):
// - Two lists, never a matrix: a Class x Subject cell is one teacher (handoff #25). No
//   teacher is named anywhere in the answer.
// - The numbers: the Students placed, attendance %, content completed %, the Students below
//   the KKTP (in at least one Subject per Class, in that Subject per Subject), the Students
//   with a signal, and the average running final grade - each with its change against the
//   rows of exactly 7 days before, null where there are none.
// - The Subject list is keyed Subject x grade level, summed from that grade's slot rows; its
//   signals are the teacher's rule, the Class list's the Homeroom Teacher's (ticket 05).
// - A line for the School above the lists (owner's pick): the numbers its Governing Body sees
//   (ticket 07).
// - The current Semester by default, or any CLOSED one. A CLOSED Semester's grades and
//   below-KKTP come from each Student's newest Report Card, the rest from its last rollup, and
//   carry no change (owner's pick): it is the final picture.
// - A Class with no row, and everything before the first rollup, is null, never 0.
// - Percentages are whole, as the other views show them; the average grade has one decimal;
//   a change is the difference of the two shown values.
// - For the Principal and the Vice Principals, checked against the database (ADR-0009).

const DAY_MS = 24 * 60 * 60 * 1000;

// The rows a change is read against.
const CHANGE_DAYS = 7;

const SEMESTER_NOT_FOUND = 'Semester not found';

// The figures that carry a change; the Students placed carry none.
const FIGURES = ['attendance', 'content', 'belowKktp', 'withSignal', 'averageGrade'];

const choiceSelect = {
    id: true,
    ordinal: true,
    status: true,
    startDate: true,
    academicYearId: true,
    academicYear: { select: { id: true, label: true } },
};

// The counts a rollup row carries, summed into a Subject's.
const COUNTS = [
    'studentsPlacedNow',
    'attendancePresent',
    'attendanceCounted',
    'contentCompleted',
    'contentPossible',
    'gradeSum',
    'gradeCount',
    'belowKktp',
    'withSignal',
];

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const semesterChoiceView = (row) => ({
    id: row.id,
    ordinal: row.ordinal,
    status: row.status,
    academicYear: { id: row.academicYear.id, label: row.academicYear.label },
});

const averageOf = (sum, count) => (count ? Math.round((sum * 10) / count) / 10 : null);

// The figures one set of counts shows; null for none.
const figuresOf = (counts) =>
    counts
        ? {
            studentsPlacedNow: counts.studentsPlacedNow ?? null,
            attendance: percentOf(counts.attendancePresent, counts.attendanceCounted),
            content: percentOf(counts.contentCompleted, counts.contentPossible),
            belowKktp: counts.belowKktp ?? null,
            withSignal: counts.withSignal ?? null,
            averageGrade: averageOf(counts.gradeSum, counts.gradeCount),
        }
        : null;

const changeOf = (value, earlier) =>
    value === null || earlier === null || earlier === undefined ? null : Math.round((value - earlier) * 10) / 10;

// Each figure with its change against the counts of 7 days before, if any.
function numbersView(counts, before) {
    const now = figuresOf(counts);
    const then = figuresOf(before);
    return {
        studentsPlacedNow: now?.studentsPlacedNow ?? null,
        ...Object.fromEntries(
            FIGURES.map((key) => {
                const value = now?.[key] ?? null;
                return [key, { value, change: changeOf(value, then?.[key]) }];
            })
        ),
    };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const sumOf = (rows) =>
    rows.length ? Object.fromEntries(COUNTS.map((key) => [key, rows.reduce((sum, row) => sum + row[key], 0)])) : null;

const subjectKeyOf = (subjectId, gradeLevel) => `${subjectId}:${gradeLevel}`;

// The Semester asked for, or the current one, among those that may be chosen: the current
// and every CLOSED one, newest first.
async function chosenSemesterOf(schoolId, semesterId) {
    const { semester: current } = await currentTermOf(schoolId);
    const choices = await prisma.semester.findMany({
        where: { OR: [{ status: 'CLOSED' }, ...(current ? [{ id: current.id }] : [])] },
        select: choiceSelect,
        orderBy: { startDate: 'desc' },
    });
    const wanted = semesterId ?? current?.id;
    const chosen = choices.find((row) => row.id === wanted);
    if (semesterId && !chosen) throw notFound(SEMESTER_NOT_FOUND);
    return { chosen: chosen ?? null, choices };
}

// The rollup's rows of one day of the Semester: the School's, its Classes' by Class, and its
// slots' summed by Subject and grade level.
async function rowsOfDay(semesterId, localDate) {
    if (!localDate) return { school: null, classes: new Map(), subjects: new Map() };
    const where = { semesterId, localDate };
    const [school, classes, slots] = await Promise.all([
        prisma.schoolDailyRollup.findFirst({ where }),
        prisma.classDailyRollup.findMany({ where }),
        prisma.slotDailyRollup.findMany({
            where,
            include: {
                class: { select: { gradeLevel: true } },
                subject: { select: { id: true, code: true, name: true } },
            },
        }),
    ]);
    const bySubject = new Map();
    for (const slot of slots) {
        const key = subjectKeyOf(slot.subjectId, slot.class.gradeLevel);
        if (!bySubject.has(key)) {
            bySubject.set(key, { subject: slot.subject, gradeLevel: slot.class.gradeLevel, rows: [] });
        }
        bySubject.get(key).rows.push(slot);
    }
    return {
        school,
        classes: new Map(classes.map((row) => [row.classId, row])),
        subjects: new Map([...bySubject].map(([key, entry]) => [key, { ...entry, counts: sumOf(entry.rows) }])),
    };
}

// A CLOSED Semester's grades, from each Student's newest Report Card: the grades' sum and
// count and the Students below the KKTP, for the School, per Class (the Report Card's) and
// per Subject and grade level (the Class whose slot reported it).
async function reportCardGradesOf(semesterId) {
    const cards = await prisma.reportCard.findMany({
        where: { semesterId },
        select: {
            studentProfileId: true,
            version: true,
            classId: true,
            subjects: {
                select: {
                    subjectId: true,
                    subjectCode: true,
                    subjectName: true,
                    finalGrade: true,
                    kktp: true,
                    class: { select: { gradeLevel: true } },
                },
            },
        },
    });
    const newest = new Map();
    for (const card of cards) {
        const held = newest.get(card.studentProfileId);
        if (!held || card.version > held.version) newest.set(card.studentProfileId, card);
    }

    const tally = () => ({ gradeSum: 0, gradeCount: 0, below: new Set() });
    const school = tally();
    const classes = new Map();
    const subjects = new Map();
    const add = (into, student, line) => {
        into.gradeSum += line.finalGrade;
        into.gradeCount += 1;
        if (line.finalGrade < line.kktp) into.below.add(student);
    };
    for (const card of newest.values()) {
        if (!classes.has(card.classId)) classes.set(card.classId, tally());
        for (const line of card.subjects) {
            const key = subjectKeyOf(line.subjectId, line.class.gradeLevel);
            if (!subjects.has(key)) {
                subjects.set(key, {
                    ...tally(),
                    subject: { id: line.subjectId, code: line.subjectCode, name: line.subjectName },
                    gradeLevel: line.class.gradeLevel,
                });
            }
            for (const into of [school, classes.get(card.classId), subjects.get(key)]) {
                add(into, card.studentProfileId, line);
            }
        }
    }
    const gradesOf = (entry) =>
        entry ? { gradeSum: entry.gradeSum, gradeCount: entry.gradeCount, belowKktp: entry.below.size } : null;
    return {
        school: newest.size ? gradesOf(school) : null,
        classes: new Map([...classes].map(([classId, entry]) => [classId, gradesOf(entry)])),
        subjects,
        gradesOf,
    };
}

// A CLOSED Semester's counts: the last rollup's, its grades and below-KKTP the Report Cards'.
const closedCountsOf = (rollup, grades) =>
    rollup || grades
        ? {
            ...(rollup ?? {}),
            gradeSum: grades?.gradeSum ?? null,
            gradeCount: grades?.gradeCount ?? null,
            belowKktp: grades?.belowKktp ?? null,
        }
        : null;

// GET /api/dashboard/school?semesterId= (ticket 06): for the Principal or a Vice Principal,
// checked against the database as the marking count is (ADR-0009); 403 to anyone else.
async function schoolDashboard(auth, { semesterId }) {
    await assertPrincipalOrVice(auth);
    const { chosen, choices } = await chosenSemesterOf(auth.schoolId, semesterId);
    const answer = {
        semester: chosen ? semesterChoiceView(chosen) : null,
        semesters: choices.map(semesterChoiceView),
        asOf: null,
        comparedWith: null,
        school: numbersView(null, null),
        classes: [],
        subjects: [],
    };
    if (!chosen) return answer;

    const closed = chosen.status === 'CLOSED';
    const latest = await prisma.schoolDailyRollup.findFirst({
        where: { semesterId: chosen.id },
        orderBy: { localDate: 'desc' },
        select: { localDate: true, takenAt: true },
    });
    const beforeDate = latest && !closed ? new Date(latest.localDate.getTime() - CHANGE_DAYS * DAY_MS) : null;
    const [now, before, grades, classes, slots] = await Promise.all([
        rowsOfDay(chosen.id, latest?.localDate),
        rowsOfDay(chosen.id, beforeDate),
        closed ? reportCardGradesOf(chosen.id) : null,
        prisma.class.findMany({
            where: { academicYearId: chosen.academicYearId },
            select: { id: true, name: true, gradeLevel: true },
            orderBy: [{ gradeLevel: 'asc' }, { name: 'asc' }],
        }),
        prisma.classSubject.findMany({
            where: { semesterId: chosen.id, status: 'ACTIVE' },
            select: {
                subject: { select: { id: true, code: true, name: true } },
                class: { select: { gradeLevel: true } },
            },
        }),
    ]);

    // The Subjects of the Semester's slots, and any a row or a Report Card still names.
    const subjects = new Map();
    const listSubject = (subject, gradeLevel) => {
        const key = subjectKeyOf(subject.id, gradeLevel);
        if (!subjects.has(key)) subjects.set(key, { subject, gradeLevel });
    };
    for (const slot of slots) listSubject(slot.subject, slot.class.gradeLevel);
    for (const entry of now.subjects.values()) listSubject(entry.subject, entry.gradeLevel);
    for (const entry of grades?.subjects.values() ?? []) listSubject(entry.subject, entry.gradeLevel);

    const countsOf = (rollup, closedGrades) => (closed ? closedCountsOf(rollup, closedGrades) : rollup);
    return {
        ...answer,
        asOf: latest?.takenAt ?? null,
        comparedWith: before.school ? before.school.localDate.toISOString().slice(0, 10) : null,
        school: numbersView(countsOf(now.school, grades?.school), before.school),
        classes: classes.map((klass) => ({
            class: klass,
            ...numbersView(
                countsOf(now.classes.get(klass.id), grades?.classes.get(klass.id)),
                before.classes.get(klass.id)
            ),
        })),
        subjects: [...subjects]
            .map(([key, { subject, gradeLevel }]) => ({
                subject,
                gradeLevel,
                ...numbersView(
                    countsOf(now.subjects.get(key)?.counts, grades?.gradesOf(grades.subjects.get(key))),
                    before.subjects.get(key)?.counts
                ),
            }))
            .sort((a, b) => a.gradeLevel - b.gradeLevel || a.subject.name.localeCompare(b.subject.name)),
    };
}

export { schoolDashboard };
