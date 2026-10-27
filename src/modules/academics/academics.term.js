import { prisma } from '../../shared/prisma.js';
import { toDay } from '../holidays/holidays.calendar.js';
import { todayOf } from '../sessions/sessions.service.js';

// A School's current year and Semester (governing-body ticket 07, owner 2026-10-26), here
// since dashboard ticket 01 (2026-10-26): the dashboards read it too, and the Governing
// Body's reads will read the dashboard's numbers (dashboard ticket 07), so neither module
// may hold it for the other.
//
// Several years may be ACTIVE at once (academics, owner 2026-09-23). So the year is the
// latest ACTIVE one begun by the School's today, else its earliest. The Semester is that
// year's latest begun, else its first, as a Student's menu opens (assessment 07).

// Of rows ordered by their start, the latest begun by today, else the first.
const latestBegun = (rows, today) => rows.filter((row) => toDay(row.startDate) <= today).at(-1) ?? rows[0] ?? null;

// The School's current year and Semester, read in its scope. Either may be null: a
// School with no ACTIVE year, or a year with no Semester yet. The nightly rollup passes
// the moment it rolls up at, so a probe can fix it (dashboard ticket 05).
async function currentTermOf(schoolId, now = new Date()) {
    const [today, years] = await Promise.all([
        todayOf(schoolId, now),
        prisma.academicYear.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true, label: true, startDate: true },
            orderBy: { startDate: 'asc' },
        }),
    ]);
    const year = latestBegun(years, today);
    if (!year) return { year: null, semester: null };

    // The end too, for the Semester's span (the Homeroom Teacher's dashboard, ticket 03).
    const semesters = await prisma.semester.findMany({
        where: { academicYearId: year.id },
        select: { id: true, ordinal: true, startDate: true, endDate: true },
        orderBy: { startDate: 'asc' },
    });
    return { year, semester: latestBegun(semesters, today) };
}

export { currentTermOf };
