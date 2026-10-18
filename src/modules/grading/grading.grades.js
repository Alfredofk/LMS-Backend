import { prisma } from '../../shared/prisma.js';
import { rosterOf } from '../tracking/tracking.service.js';
import { standingsOf, byName } from '../assessment/assessment.marking.js';
import { exceptionsOf, ownTermsOf, hardEndIn, isListedThrough } from '../assessment/assessment.submission.js';
import { loadForStaff, slotSettingsOf } from './grading.service.js';
import { slotReportingOf } from './grading.reporting.js';
import { ruleResultOf, finalGradeOf } from './grading.compute.js';
import { descriptionsOf } from './grading.texts.js';

// A slot's running grades (grading-and-report-card ticket 02), for its staff: the
// Answering Teacher, the Homeroom Teacher, the Principal and the Vice Principals
// (staffStandingOf). Computed live (grading.compute.js) and stored nowhere; the Report
// Card freezes them (ticket 05). It reads Scores and writes none, though the standings
// close an attempt past its deadline, as every read of them does.
//
// Owner's decisions (2026-10-13, the spec, and the build decisions of 2026-10-14):
// - What counts for a Student: a published Assessment of the Subject in the Semester,
//   not cancelled, that they are answerable for (isListedThrough) - of this Class, and
//   for one who moved in, of every Class they sat in during the Semester
//   (grading.reporting.js).
// - On each, the Score that counts after the school's Remedial Rule. "Did not submit" -
//   the standings' DID_NOT_SUBMIT, online or offline - counts 0 and is flagged. Not
//   started yet, in progress, or waiting for marking or release counts nothing yet and
//   is flagged waiting: finalising (ticket 04) refuses while one waits, so a Report Card
//   never meets one.
// - The weights and the KKTP are this slot's, for every Student it reports. One whose
//   grade another Class's slot reports - they moved on - is listed with that Class and
//   no grade.
// - The standings are standingsOf's, the read behind the recap and the results, so a
//   Student who did not submit here did not submit there.
// - Never a Student's to read (spec invariant 6): the route hides it from them.
// - Each Student carries describedHere - whether this slot writes their Description -
//   and, where it reports them, the Description stored (ticket 03, grading.texts.js).

// What the standings and a Student's own terms read of an Assessment.
const gradedAssessmentSelect = {
    id: true,
    type: true,
    mode: true,
    opensAt: true,
    closesAt: true,
    maxAttempts: true,
    acceptLate: true,
    classSubject: { select: { classId: true } },
};

// The statuses that count: a Score, or 0 for "did not submit".
const COUNTED = new Set(['RELEASED', 'DID_NOT_SUBMIT']);

const pairOf = (assessmentId, studentProfileId) => `${assessmentId}:${studentProfileId}`;

const classSubjectView = (row) => ({
    id: row.id,
    class: { id: row.classId, name: row.class.name },
    academicYear: row.class.academicYear.label,
    subject: row.subject,
    semester: { id: row.semesterId, ordinal: row.semester.ordinal, status: row.semester.status },
});

// The Scores that count on one Assessment, from its standing's released attempts.
const countingOf = (standing) =>
    standing.attempts
        .filter((attempt) => attempt.status === 'RELEASED' && attempt.score)
        .map((attempt) => ({ remedial: attempt.remedial, value: attempt.score.value }));

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// The slot's roster - and anyone with a Submission in its Assessments, as the recap
// lists them - each with the Class whose slot reports them and, where this one does,
// their grade: each type's average and the weight it carries, the final grade, and
// how many Assessments did not submit, wait, were moved by the Remedial Rule, or come
// from an earlier Class.
async function slotGrades(auth, id) {
    const { classSubject } = await loadForStaff(auth, id);
    const { classId, subjectId, semesterId } = classSubject;
    const [roster, settings] = await Promise.all([rosterOf(auth, classSubject), slotSettingsOf(classSubject)]);
    const reporting = await slotReportingOf(auth, classSubject, roster);
    const { span, spans, spansOf, classOf, reportingOf, isReportedHere } = reporting;

    // This Class's Assessments, and those of every Class a Student it reports sat in.
    const classIds = [
        ...new Set([classId, ...spans.filter((row) => isReportedHere(row.studentProfileId)).map((row) => row.classId)]),
    ];
    const rows = await prisma.assessment.findMany({
        where: {
            deletedAt: null,
            publishedAt: { not: null },
            cancelledAt: null,
            classSubject: { classId: { in: classIds }, subjectId, semesterId, status: 'ACTIVE' },
        },
        select: gradedAssessmentSelect,
    });
    const [standings, exceptions, descriptions] = await Promise.all([
        rows.length ? standingsOf(rows, roster, new Date()) : new Map(),
        exceptionsOf({ assessmentId: { in: rows.map((row) => row.id) } }),
        descriptionsOf(classSubject, roster, reporting),
    ]);
    const exceptionOfPair = new Map(exceptions.map((row) => [pairOf(row.assessmentId, row.studentProfileId), row]));
    const standingOfPair = new Map();
    for (const [assessmentId, ofRow] of standings) {
        for (const standing of ofRow) standingOfPair.set(pairOf(assessmentId, standing.studentProfileId), standing);
    }

    const students = new Map(
        roster.studentProfileIds.map((studentProfileId) => [
            studentProfileId,
            {
                studentProfileId,
                fullName: roster.nameOf.get(studentProfileId) ?? null,
                placedNow: roster.placedNow(studentProfileId),
            },
        ])
    );
    for (const row of rows.filter((found) => found.classSubject.classId === classId)) {
        for (const { studentProfileId, fullName, placedNow } of standings.get(row.id)) {
            if (students.has(studentProfileId)) continue;
            students.set(studentProfileId, { studentProfileId, fullName, placedNow });
        }
    }

    const gradeOf = (studentProfileId) => {
        const entries = [];
        const counts = { didNotSubmit: 0, waiting: 0, remedialRuleMoved: 0, pooled: 0 };
        for (const row of rows) {
            const standing = standingOfPair.get(pairOf(row.id, studentProfileId));
            if (!standing) continue;
            const terms = ownTermsOf(row, exceptionOfPair.get(pairOf(row.id, studentProfileId)) ?? null);
            const placed = spansOf(studentProfileId).filter((found) => found.classId === row.classSubject.classId);
            const hardEnd = hardEndIn(row, terms, span.end);
            if (!isListedThrough(placed, terms.opensAt, hardEnd, standing.attempts.length > 0)) continue;
            if (!COUNTED.has(standing.status)) {
                counts.waiting += 1;
                continue;
            }

            const result =
                standing.status === 'RELEASED'
                    ? ruleResultOf(countingOf(standing), settings.remedialRule.value, settings.kktp.value)
                    : { value: 0, moved: false };
            if (standing.status === 'DID_NOT_SUBMIT') counts.didNotSubmit += 1;
            if (result.moved) counts.remedialRuleMoved += 1;
            if (row.classSubject.classId !== classId) counts.pooled += 1;
            entries.push({ type: row.type, value: result.value });
        }
        return { ...finalGradeOf(entries, settings.weights.value), ...counts };
    };

    return {
        classSubject: classSubjectView(classSubject),
        settings,
        students: [...students.values()].sort(byName).map((student) => ({
            ...student,
            reportedHere: isReportedHere(student.studentProfileId),
            reportedBy: classOf.get(reportingOf.get(student.studentProfileId)) ?? null,
            grade: isReportedHere(student.studentProfileId) ? gradeOf(student.studentProfileId) : null,
            describedHere: descriptions.isDescribedHere(student.studentProfileId),
            description: isReportedHere(student.studentProfileId)
                ? descriptions.descriptionOf(student.studentProfileId)
                : null,
        })),
    };
}

export { slotGrades };
