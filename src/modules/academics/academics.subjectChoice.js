import { prisma } from '../../shared/prisma.js';
import { assertPrincipalOrVice, isPrincipalOrVice } from '../../shared/guards.js';
import { recordAudit } from '../../shared/approval.js';
import { badRequest, conflict } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('Academics');

// Which national Subjects a school uses (registration-and-membership ticket 20,
// owner 2026-10-04). Split out of academics.service.js by the review of that
// ticket, under the split rule in CODING_STANDARDS.md. academics.service.js reads
// assertSubjectSelected from here, and this file imports nothing of it.
//
// - The Principal or a Vice Principal names the whole list at once: every national
//   Subject left out is deselected. A school that never chose uses all 18.
// - A row is kept only for a Subject whose choice ever changed. Selecting it again
//   flips the row back, and nothing is deleted. Each change is audited
//   UPDATE_SUBJECTS, against the school.
// - A deselected Subject takes no new ClassSubject (assertSubjectSelected). One
//   already running keeps going to its end.
// - The leaders see every national Subject with its running and waiting counts, a
//   warning before they untick one. Everyone else sees only those in use.

// The school's subject choice is audited against the school, as its other
// settings are (location, time zone, joint leave).
const SCHOOL_SUBJECT = 'School';

const NO_CLASS_SUBJECTS = { activeClassSubjects: 0, pendingRequests: 0 };

const CHANGED_AT_ONCE = 'The subjects were changed by someone else at the same moment. Try again';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// The national Subjects this school has deselected. One with no row, or a row
// selected again, is in use.
async function deselectedSubjectIds() {
    const rows = await prisma.schoolSubjectChoice.findMany({
        where: { selected: false },
        select: { subjectId: true },
    });
    return new Set(rows.map((row) => row.subjectId));
}

// A deselected national Subject takes no new ClassSubject: it is not asked for,
// not approved, not assigned by override (owner, 2026-10-04). One already running
// keeps going to its end, and a replacement continues it. The refusal names the
// Subject, so a bulk approval says which one stopped (review of ticket 20).
async function assertSubjectSelected(subject) {
    const deselected = await prisma.schoolSubjectChoice.findFirst({
        where: { subjectId: subject.id, selected: false },
        select: { id: true },
    });
    if (!deselected) return;

    const name = `${subject.code} ${subject.name}`;
    throw badRequest(`This school does not use ${name}. The Principal or a Vice Principal can select it again`);
}

// What a deselection would leave running, for the leaders' warning before they
// untick a Subject (ticket 20, owner 2026-10-04). Per Subject: the ClassSubjects
// still running, and the requests waiting, in an OPEN Semester of an ACTIVE year -
// the same "live" loadLiveAssignment uses. A warning only: nothing is refused on it.
async function classSubjectCountsBySubject() {
    const groups = await prisma.classSubject.groupBy({
        by: ['subjectId', 'status'],
        where: {
            status: { in: ['ACTIVE', 'PENDING'] },
            endedAt: null,
            semester: { status: 'OPEN', academicYear: { status: 'ACTIVE' } },
        },
        _count: { _all: true },
    });

    const counts = new Map();
    for (const group of groups) {
        const entry = counts.get(group.subjectId) ?? { ...NO_CLASS_SUBJECTS };
        if (group.status === 'ACTIVE') entry.activeClassSubjects = group._count._all;
        else entry.pendingRequests = group._count._all;
        counts.set(group.subjectId, entry);
    }
    return counts;
}

// The national catalog (schoolId null, from migration national_subject_catalog)
// plus this school's local subjects. The tenant extension reads both for Subject
// (CATALOG_MODELS in shared/prisma.js), so nothing here names a school.
//
// The Principal and a Vice Principal see every national Subject, so they can select
// a deselected one again; everyone else sees only those in use (ticket 20). A
// local Subject is always selected. The leaders also get each Subject's counts
// (classSubjectCountsBySubject), a local one's too, so every row has one shape.
async function listSubjects(auth) {
    const [subjects, deselected, isLeader] = await Promise.all([
        prisma.subject.findMany({
            select: { id: true, code: true, name: true, schoolId: true },
            orderBy: { code: 'asc' },
        }),
        deselectedSubjectIds(),
        isPrincipalOrVice(auth.membershipId),
    ]);
    const counts = isLeader ? await classSubjectCountsBySubject() : null;

    return subjects
        .map((subject) => ({
            id: subject.id,
            code: subject.code,
            name: subject.name,
            national: subject.schoolId === null,
            selected: !deselected.has(subject.id),
            ...(counts ? (counts.get(subject.id) ?? NO_CLASS_SUBJECTS) : {}),
        }))
        .filter((subject) => isLeader || subject.selected)
        .sort((a, b) => Number(b.national) - Number(a.national));
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

// The national Subjects the school uses, named in full (ticket 20): every one left
// out is deselected, so an empty list deselects all 18. In one transaction, so a
// "select all" lands whole or not at all. A row is written only for a Subject
// whose choice changes, and each change is audited; saving the same list twice
// changes nothing. Selecting again flips the row back - nothing is deleted.
//
// Each flip is a claim on the choice it read (review of ticket 20): of two saves
// at the same moment, the second loses whole with a 409, so one change is never
// audited twice. A stray id is named in the error's details, not its message.
async function selectSubjects(auth, { selectedIds }) {
    await assertPrincipalOrVice(auth);

    const national = await prisma.subject.findMany({
        where: { schoolId: null },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
    });
    const wanted = new Set(selectedIds);
    const known = new Set(national.map((subject) => subject.id));
    const stray = [...wanted].filter((id) => !known.has(id));
    if (stray.length) throw badRequest('Only national subjects can be selected', { notNational: stray });

    let changes;
    try {
        changes = await prisma.$transaction(async (tx) => {
            const choices = await tx.schoolSubjectChoice.findMany({
                select: { id: true, subjectId: true, selected: true },
            });
            const bySubject = new Map(choices.map((choice) => [choice.subjectId, choice]));
            const lines = [];

            for (const subject of national) {
                const selected = wanted.has(subject.id);
                const existing = bySubject.get(subject.id);
                if ((existing?.selected ?? true) === selected) continue;

                if (existing) {
                    const claimed = await tx.schoolSubjectChoice.updateMany({
                        where: { id: existing.id, selected: existing.selected },
                        data: { selected, decidedByUserId: auth.userId },
                    });
                    if (claimed.count === 0) throw conflict(CHANGED_AT_ONCE);
                } else {
                    await tx.schoolSubjectChoice.create({
                        data: { subjectId: subject.id, selected, decidedByUserId: auth.userId },
                    });
                }

                const line = `${subject.code} ${subject.name}: ${selected ? 'selected' : 'deselected'}`;
                await recordAudit({
                    schoolId: auth.schoolId,
                    subjectType: SCHOOL_SUBJECT,
                    subjectId: auth.schoolId,
                    action: 'UPDATE_SUBJECTS',
                    actorUserId: auth.userId,
                    reason: line,
                    client: tx,
                });
                lines.push(line);
            }
            return lines;
        });
    } catch (error) {
        // Two saves at the same moment both creating the same Subject's first row.
        if (error?.code === 'P2002') throw conflict(CHANGED_AT_ONCE);
        throw error;
    }

    if (changes.length) log.info(`Subjects at ${auth.schoolName}: ${changes.join('; ')}`);
    return listSubjects(auth);
}

export { assertSubjectSelected, listSubjects, selectSubjects };
