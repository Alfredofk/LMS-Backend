import { prisma } from '../../shared/prisma.js';
import { semesterSpan } from '../sessions/sessions.service.js';
import { slotSettingsOf } from './grading.service.js';

// Which slot reports a Student's grade for a Subject in a Semester (grading-and-report-card
// ticket 02). It reads placements and slots, and imports nothing of assessment, so the
// Student's own reads there use it as the slot's grade view does.
//
// Owner's decisions (2026-10-13, the spec, and the build decisions of 2026-10-14):
// - A Student who moved Class in the Semester has one grade per Subject. It pools their
//   Assessments of it from every Class they sat in during the Semester, with the last
//   Class's slot's weights and KKTP: the last of those Classes that has the Subject, so
//   a Subject only their earlier Class had is still reported, by that Class's slot.
// - The KKTP the cap reads is that slot's too, so the after-rule Score a Student is
//   shown is the one their grade counts.
// - The grade view of an earlier Class shows them reported by the last, with no grade.
// - Who gets a Report Card (ticket 05, owner 2026-10-19): a Student with a live
//   profile, placed in a Class of the year now, who sat in a Class of the year at some
//   time during the Semester. One who joined after it ended gets none, and their Note
//   is not asked for. Closing, the readiness board's Notes, the Homeroom Teacher's Notes
//   and the slot's NO_GRADE blocker all read it here.

const overlaps = (span, { start, end }) => span.startedAt < end && (span.endedAt === null || span.endedAt > start);

// When a placement ended; an open one last of all.
const endOf = (span) => (span.endedAt === null ? Infinity : span.endedAt.getTime());

// The placements of these Students in these Classes that overlap the Semester's span
// (semesterSpan): the ones that decide where they sat during it.
async function semesterPlacementsOf(studentProfileIds, classIds, span) {
    const rows = await prisma.classMembership.findMany({
        where: { studentProfileId: { in: studentProfileIds }, classId: { in: classIds } },
        select: { classId: true, studentProfileId: true, startedAt: true, endedAt: true },
    });
    return rows.filter((row) => overlaps(row, span));
}

// The Class that reports one Student, of their placements in the Semester in Classes
// with a slot of the Subject: the one they sat in last. Null with none.
function reportingClassOf(spans) {
    const last = spans.reduce((found, span) => (!found || endOf(span) > endOf(found) ? span : found), null);
    return last?.classId ?? null;
}

// Which Class's slot reports each Student of a slot's roster (rosterOf, passed in: this
// file imports nothing of tracking, which reads assessment) for its Subject: the
// Semester's span, the Classes with a slot of the Subject, and the placements in them
// during it. The one read behind the grade view (ticket 02) and the Descriptions
// (ticket 03), so the Students a slot grades are the ones it describes.
async function slotReportingOf(auth, classSubject, roster) {
    const { subjectId, semesterId } = classSubject;
    const [span, slots] = await Promise.all([
        semesterSpan(auth.schoolId, classSubject.semester),
        prisma.classSubject.findMany({
            where: { subjectId, semesterId, status: 'ACTIVE' },
            select: { classId: true, class: { select: { id: true, name: true } } },
        }),
    ]);
    const classOf = new Map(slots.map((slot) => [slot.classId, slot.class]));
    const spans = await semesterPlacementsOf(roster.studentProfileIds, [...classOf.keys()], span);
    const spansOf = (studentProfileId) => spans.filter((row) => row.studentProfileId === studentProfileId);
    const reportingOf = new Map(
        roster.studentProfileIds.map((profileId) => [profileId, reportingClassOf(spansOf(profileId))])
    );
    return {
        span,
        spans,
        spansOf,
        classOf,
        reportingOf,
        isReportedHere: (studentProfileId) => reportingOf.get(studentProfileId) === classSubject.classId,
    };
}

// The Remedial Rule and the KKTP a Student's Scores of these Subjects are counted with,
// by subjectId: their reporting slot's. A Subject with no reporting slot is left out.
// The semester is read with its dates.
async function remedialTermsOf(auth, studentProfileId, semester, subjectIds) {
    const [slots, span] = await Promise.all([
        prisma.classSubject.findMany({
            where: {
                semesterId: semester.id,
                subjectId: { in: subjectIds },
                status: 'ACTIVE',
                class: { memberships: { some: { studentProfileId } } },
            },
            select: { classId: true, subjectId: true },
        }),
        semesterSpan(auth.schoolId, semester),
    ]);
    const spans = await semesterPlacementsOf([studentProfileId], [...new Set(slots.map((slot) => slot.classId))], span);

    const termsOf = async (subjectId) => {
        const classIds = new Set(slots.filter((slot) => slot.subjectId === subjectId).map((slot) => slot.classId));
        const classId = reportingClassOf(spans.filter((row) => classIds.has(row.classId)));
        if (!classId) return null;
        const settings = await slotSettingsOf({ classId, subjectId, semesterId: semester.id });
        return [subjectId, { rule: settings.remedialRule.value, kktp: settings.kktp.value }];
    };
    const found = await Promise.all(subjectIds.map(termsOf));
    return new Map(found.filter(Boolean));
}

// The Students who get a Report Card for a Semester of this year, given its span
// (semesterSpan), each with the Class they are placed in now: the Class at close.
// Among the Students named, or every one of the school's; read through the client
// given, so a close reads it again inside its transaction.
async function reportCardHoldersOf(academicYearId, span, studentProfileIds = null, client = prisma) {
    const rows = await client.classMembership.findMany({
        where: {
            class: { academicYearId },
            studentProfile: { endedAt: null },
            ...(studentProfileIds ? { studentProfileId: { in: studentProfileIds } } : {}),
        },
        select: { classId: true, studentProfileId: true, startedAt: true, endedAt: true },
    });
    const satDuring = new Set(rows.filter((row) => overlaps(row, span)).map((row) => row.studentProfileId));
    return new Map(
        rows.filter((row) => row.endedAt === null && satDuring.has(row.studentProfileId))
            .map((row) => [row.studentProfileId, row.classId])
    );
}

export { semesterPlacementsOf, reportingClassOf, slotReportingOf, remedialTermsOf, reportCardHoldersOf };
