import { prisma } from '../../shared/prisma.js';
import { notFound } from '../../shared/errors.js';
import { semesterSpan, todayOf } from '../sessions/sessions.service.js';
import { toDay } from '../holidays/holidays.calendar.js';
import { remedialTermsOf } from '../grading/grading.reporting.js';
import { afterRuleOf } from '../grading/grading.compute.js';
import { studentStatusOf } from './assessment.marking.js';
import { marksOf, scoresOf, countedScoreOf, countingValuesOf } from './assessment.score.js';
import { isPractice, isHandedIn, practiceStatusOf, practiceSummaryOf } from './assessment.practice.js';
import {
    studentAssessmentSelect,
    submissionSelect,
    exceptionsOf,
    ownTermsOf,
    placementSpansOf,
    isListedThrough,
    hardEndIn,
    ownStandingOf,
    studentAssessmentView,
    closeExpiredSubmissions,
} from './assessment.submission.js';

// A Student's "my assessments" (assessment ticket 07): one menu across all their
// subjects for one Semester, under the Classes they sat in during it. It reads, and
// writes nothing but the closing of an attempt past its deadline, as every read of
// one does (closeExpiredSubmissions). Each Assessment carries what its outline says
// they may still do, and where they stand on it.
//
// Owner's decisions (2026-10-04, and the build decisions of 2026-10-11):
// - The Student chooses a Semester; semesterId names its year too. The answer lists
//   the Semesters they may choose: those one of their placements overlaps.
// - With none chosen, the Semester covering today in the year of the Class they sit
//   in now; between two, the latest begun; before any, the first. With no Class now,
//   the latest one they were placed in.
// - The Classes are the ones they sat in during it, each by name, Grade Level and year
//   - two years may each have a 7A - so after a Class Move both show, each Assessment
//   under its own. The Class they sit in now comes first.
// - An Assessment of a Class shows when its window, on the Student's own terms,
//   overlaps their placement there, or they have a Submission in it
//   (isListedThrough): one who moved in sees what was still open, one who moved out
//   keeps their history. Published only; a cancelled one shows, with its reason.
// - Where they stand is the staff's rule (studentStatusOf), so the menu and the
//   teacher's recap agree, with three differences: waiting for marking reads as
//   waiting for release - where the marking stands is not theirs to see; VOIDED when
//   their last attempt was voided and nothing else stands, so they answer again; and
//   CANCELLED first. "Did not submit" comes at closesAt, as for the staff, and
//   canStart says whether a late start is still taken.
// - Only in the Class they sit in now do they start; a Class they left is read.
// - The Score is the counted one, and only once released. Nothing comparative, no
//   key and no integrity count reaches them here (spec invariant 8).
// - Beside it, where the school's Remedial Rule moves it, the result after the rule
//   and the rule (grading-and-report-card ticket 02, owner 2026-10-14): the Score stays
//   raw, and the Student is shown both. Never a grade, an average or a rank.
// - Each entry says whether it was handed in late, and the KKTP its Scores are counted
//   with (frontend's notes, owner 2026-10-19), so a dashboard reads the menu alone.
//   `late` is the first attempt handed in's, void and remedial ones left out - a
//   remedial has its own window - and null with none, or on an OFFLINE one. `kktp` is
//   the reporting slot's, the Remedial Rule's, and null on a LATIHAN; no weight.
// - A LATIHAN (ticket 08, owner 2026-10-18) reads NOT_STARTED, IN_PROGRESS or DONE -
//   CANCELLED and VOIDED as above - never DID_NOT_SUBMIT or waiting for release. Its
//   entry has no Score; `practice` holds its best attempt and its latest, and is null
//   on every other type.

const isOpen = (span) => span.endedAt === null;

const overlaps = (span, { start, end }) => span.startedAt < end && (span.endedAt === null || span.endedAt > start);

// Latest first: by the year's start, then the Semester's ordinal.
const latestFirst = (a, b) => b.academicYear.startDate - a.academicYear.startDate || b.ordinal - a.ordinal;

const semesterSelect = {
    id: true,
    ordinal: true,
    academicYearId: true,
    startDate: true,
    endDate: true,
    academicYear: { select: { label: true, startDate: true } },
};

const classSelect = {
    id: true,
    name: true,
    gradeLevel: true,
    academicYearId: true,
    academicYear: { select: { label: true } },
};

// ---------------------------------------------------------------------------
// The period
// ---------------------------------------------------------------------------

// The Semesters the Student may choose, latest first, each with its span in the
// school's zone: every Semester of a year they sat in a Class of that one of their
// placements there overlaps.
async function semestersOf(auth, spans, yearOfClass) {
    const semesters = await prisma.semester.findMany({
        where: { academicYearId: { in: [...new Set(yearOfClass.values())] } },
        select: semesterSelect,
    });
    const spanned = await Promise.all(
        semesters.map(async (semester) => ({ ...semester, span: await semesterSpan(auth.schoolId, semester) }))
    );
    return spanned
        .filter((semester) =>
            spans.some(
                (span) => yearOfClass.get(span.classId) === semester.academicYearId && overlaps(span, semester.span)
            )
        )
        .sort(latestFirst);
}

// The Semester a menu opens on when none is chosen (owner, 2026-10-11): in the year of
// the Class they sit in now, the latest begun - the one covering today, or between
// two the one just over - else that year's first. With no Class now, or none of its
// year's to choose, the latest they may choose.
function defaultSemesterOf(semesters, sittingIn, yearOfClass, today) {
    const yearId = sittingIn ? yearOfClass.get(sittingIn.classId) : null;
    const ofYear = semesters.filter((row) => row.academicYearId === yearId);
    if (ofYear.length === 0) return semesters[0] ?? null;
    return ofYear.find((row) => toDay(row.startDate) <= today) ?? ofYear.at(-1);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const semesterChoiceView = (semester) => ({
    id: semester.id,
    ordinal: semester.ordinal,
    academicYear: semester.academicYear.label,
});

const semesterView = (semester) => ({
    ...semesterChoiceView(semester),
    startDate: toDay(semester.startDate),
    endDate: toDay(semester.endDate),
});

// One attempt as the staff's rule counts it, read where the marking is not the
// Student's to see: handed in and not released is waiting for release.
const attemptStatusOf = (submission) => {
    if (submission.voidedAt) return 'VOID';
    if (!submission.submittedAt) return 'IN_PROGRESS';
    return submission.releasedAt ? 'RELEASED' : 'WAITING_FOR_RELEASE';
};

// Where the Student stands on one Assessment: the staff's rule - a LATIHAN's own
// (ticket 08) - with the menu's differences (owner, 2026-10-11): CANCELLED first, and
// VOIDED where their last attempt was voided and nothing else stands.
function standingStatusOf(row, submissions, countedScore, closesAt, now) {
    if (row.cancelledAt) return 'CANCELLED';
    const attempts = submissions.map((submission) => ({ status: attemptStatusOf(submission) }));
    const status = isPractice(row)
        ? practiceStatusOf(submissions)
        : studentStatusOf(attempts, countedScore, closesAt, now);
    const unanswered = status === 'NOT_STARTED' || status === 'DID_NOT_SUBMIT';
    return unanswered && submissions.at(-1)?.voidedAt ? 'VOIDED' : status;
}

// Whether the Student handed it in late (owner, 2026-10-19): their first attempt
// handed in, its late counted from their own closesAt, a make-up's if any. A void one
// is left out, and so is a remedial, which has its own window. Null with none handed
// in, and on an OFFLINE one, which takes no hand-in.
function lateOf(row, submissions) {
    if (row.mode === 'OFFLINE') return null;
    const first = submissions.find((submission) => isHandedIn(submission) && !submission.remedial);
    return first ? first.late : null;
}

const classView = (row, current) => ({
    id: row.id,
    name: row.name,
    gradeLevel: row.gradeLevel,
    academicYear: row.academicYear.label,
    current,
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// The menu for one Semester - semesterId, or the default - with the Semesters to
// choose from. A Semester not theirs to choose, another school's included, is a 404.
async function menuOf(auth, { semesterId }) {
    const spans = await placementSpansOf(auth.membershipId);
    const classRows = await prisma.class.findMany({
        where: { id: { in: [...new Set(spans.map((span) => span.classId))] } },
        select: classSelect,
    });
    const classById = new Map(classRows.map((row) => [row.id, row]));
    const yearOfClass = new Map(classRows.map((row) => [row.id, row.academicYearId]));

    const semesters = await semestersOf(auth, spans, yearOfClass);
    const sittingIn = spans.find(isOpen) ?? null;
    const semester = semesterId
        ? semesters.find((row) => row.id === semesterId)
        : defaultSemesterOf(semesters, sittingIn, yearOfClass, await todayOf(auth.schoolId));
    if (semesterId && !semester) throw notFound('Semester not found');
    const choices = semesters.map(semesterChoiceView);
    if (!semester) return { semester: null, semesters: choices, classes: [] };

    // The Classes they sat in during it: the one they sit in now first, then the
    // latest left.
    const inSemester = spans.filter(
        (span) => yearOfClass.get(span.classId) === semester.academicYearId && overlaps(span, semester.span)
    );
    const spansOf = (classId) => spans.filter((span) => span.classId === classId);
    const leftAt = (classId) =>
        spansOf(classId).some(isOpen) ? Infinity : Math.max(...spansOf(classId).map((span) => span.endedAt));
    const classIds = [...new Set(inSemester.map((span) => span.classId))].sort((a, b) => leftAt(b) - leftAt(a));

    const { studentProfileId } = spans[0];
    const now = new Date();
    const rows = await prisma.assessment.findMany({
        where: {
            deletedAt: null,
            publishedAt: { not: null },
            classSubject: { classId: { in: classIds }, semesterId: semester.id, status: 'ACTIVE' },
        },
        select: studentAssessmentSelect,
        orderBy: [{ opensAt: 'asc' }, { createdAt: 'asc' }],
    });
    const ofRows = { studentProfileId, assessmentId: { in: rows.map((row) => row.id) } };
    await closeExpiredSubmissions(ofRows, now);
    const [submissions, exceptions] = await Promise.all([
        prisma.submission.findMany({ where: ofRows, select: submissionSelect, orderBy: { attempt: 'asc' } }),
        exceptionsOf(ofRows),
    ]);
    // A LATIHAN's attempts handed in, whose marks give its best and latest (ticket 08).
    const practiceIds = new Set(rows.filter(isPractice).map((row) => row.id));
    const handedInPractice = submissions.filter(
        (submission) => practiceIds.has(submission.assessmentId) && isHandedIn(submission)
    );
    const [scores, marks] = await Promise.all([
        scoresOf(
            prisma,
            submissions.filter((submission) => submission.releasedAt).map((submission) => submission.id)
        ),
        handedInPractice.length ? marksOf(prisma, handedInPractice) : new Map(),
    ]);

    // Each Assessment it shows, in the Class it belongs to, and the graded ones, for the
    // KKTP and the Remedial Rule below.
    const entriesOf = new Map(classIds.map((classId) => [classId, []]));
    const gradedEntries = [];
    for (const row of rows) {
        const { classId } = row.classSubject;
        const own = submissions.filter((submission) => submission.assessmentId === row.id);
        const exception = exceptions.find((found) => found.assessmentId === row.id) ?? null;
        const terms = ownTermsOf(row, exception);
        const hardEnd = hardEndIn(row, terms, semester.span.end);
        if (!isListedThrough(spansOf(classId), terms.opensAt, hardEnd, own.length > 0)) continue;

        const current = spansOf(classId).some(isOpen);
        const score = countedScoreOf(own, scores);
        const entry = {
            assessment: studentAssessmentView(row, exception),
            status: standingStatusOf(row, own, score, terms.closesAt, now),
            late: lateOf(row, own),
            score,
            afterRule: null,
            kktp: null,
            practice: isPractice(row) ? practiceSummaryOf(own, marks) : null,
            ...ownStandingOf(row, terms, exception, own, { now, hardEnd, current }),
        };
        entriesOf.get(classId).push(entry);
        if (!isPractice(row)) {
            const counting = countingValuesOf(own, scores);
            gradedEntries.push({ entry, counting, subjectId: row.classSubject.subject.id });
        }
    }

    // The KKTP and the rule are the reporting slot's, read once per Subject: every
    // graded entry carries the KKTP, and the result after the rule where a remedial
    // Score counts.
    if (gradedEntries.length) {
        const subjectIds = [...new Set(gradedEntries.map(({ subjectId }) => subjectId))];
        const termsOf = await remedialTermsOf(auth, studentProfileId, semester, subjectIds);
        for (const { entry, counting, subjectId } of gradedEntries) {
            const remedialTerms = termsOf.get(subjectId);
            if (!remedialTerms) continue;
            entry.kktp = remedialTerms.kktp;
            if (counting.some((found) => found.remedial)) entry.afterRule = afterRuleOf(counting, remedialTerms);
        }
    }

    return {
        semester: semesterView(semester),
        semesters: choices,
        classes: classIds.map((classId) => ({
            ...classView(classById.get(classId), spansOf(classId).some(isOpen)),
            assessments: entriesOf.get(classId),
        })),
    };
}

export { menuOf };
