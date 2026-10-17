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

export { semesterPlacementsOf, reportingClassOf, remedialTermsOf };
