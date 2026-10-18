import { prisma } from '../../shared/prisma.js';
import { isPrincipalOrVice, isHomeroomOf } from '../../shared/guards.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { rosterOf } from '../tracking/tracking.service.js';
import { byName } from '../assessment/assessment.marking.js';
import { describe, loadManaged, slotKeyOf } from './grading.service.js';
import { slotReportingOf } from './grading.reporting.js';

const log = createLogger('Grading');

// The words on the Report Card (grading-and-report-card ticket 03): the Answering
// Teacher's Description of each Student a slot reports for, and the Homeroom Teacher's
// Note on each Student for a Semester. Finalising (ticket 04) will refuse a slot with a
// Student it describes and has no Description of; closing (ticket 05) freezes both into
// the Report Card. A Student reads neither before then (the spec's "Who reads what").
//
// Owner's decisions (2026-10-13, the spec; the build decisions of 2026-10-17):
// - A Description is free text per Student x slot, written by the slot's Answering
//   Teacher - the successor too, who changes the predecessor's - and required, so it is
//   never emptied. It is written for the Students the slot reports for
//   (grading.reporting.js): a mover is described by their last Class's slot of the
//   Subject, and by an earlier Class's only for a Subject their last Class has no slot
//   of. One who has left the School needs none and takes none.
// - A Note is free text per Student x Semester, optional, written by the Homeroom
//   Teacher of the Class the Student is placed in now, so a mover's is their new
//   Class's. Clearing one nulls its text, and the row stays.
// - Both are plain text of at most 1,000 characters (the schema's), and neither is
//   audited: the row says who wrote it last.
// - Both are written in bulk, many Students in one request, all of them or none. Each
//   row sends back the updatedAt it read, or null where it read none; one stale row
//   refuses the whole request with 409, naming whose.
// - A CLOSED Semester or a closed year takes neither (409). Finalising will lock a
//   slot's Descriptions too (ticket 04).

const textSelect = { id: true, studentProfileId: true, text: true, updatedAt: true };

// What a read gives of a stored row: its text - null for a cleared Note - and the
// updatedAt a write sends back. Null where nothing was ever written.
const textView = (row) => (row ? { text: row.text, updatedAt: row.updatedAt } : null);

// 'Andi', 'Andi and Budi', 'Andi, Budi and Cici'.
const listOf = (names) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

const namesOf = (studentProfileIds, nameOf) => listOf(studentProfileIds.map((id) => nameOf.get(id) ?? 'a student'));

function changedMeanwhile(studentProfileIds, nameOf) {
    const whose = studentProfileIds.length ? ` for ${namesOf(studentProfileIds, nameOf)}` : '';
    return conflict(`What was saved${whose} changed meanwhile. Reload and try again`, { studentProfileIds });
}

// ---------------------------------------------------------------------------
// Writing over what was read
// ---------------------------------------------------------------------------

// Saves each row over the version its caller read, all of them or none (owner,
// 2026-10-17). A row stale against what is stored - changed since it was read, or
// written by someone else where its caller read none - refuses the whole request with
// 409, naming whose. Checked first, then claimed again on each write, so a save landing
// between the two still loses cleanly; two first writes at once meet on the unique key.
// A text as it is stored writes nothing. Answers how many rows were written.
async function saveTexts({ model, key, rows, stored, nameOf, userId }) {
    const storedOf = new Map(stored.map((row) => [row.studentProfileId, row]));
    const isStale = ({ studentProfileId, updatedAt }) => {
        const row = storedOf.get(studentProfileId);
        return row ? updatedAt?.getTime() !== row.updatedAt.getTime() : updatedAt !== null;
    };
    const stale = rows.filter(isStale).map((row) => row.studentProfileId);
    if (stale.length) throw changedMeanwhile(stale, nameOf);

    const changed = rows.filter((row) => (storedOf.get(row.studentProfileId)?.text ?? null) !== row.text);
    try {
        await prisma.$transaction(async (tx) => {
            for (const { studentProfileId, text } of changed) {
                const row = storedOf.get(studentProfileId);
                const data = { text, writtenByUserId: userId };
                if (!row) {
                    await tx[model].create({ data: { ...key, studentProfileId, ...data }, select: { id: true } });
                    continue;
                }
                const claimed = await tx[model].updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data });
                if (claimed.count === 0) throw changedMeanwhile([studentProfileId], nameOf);
            }
        });
    } catch (error) {
        throw error?.code === 'P2002' ? changedMeanwhile([], nameOf) : error;
    }
    return changed.length;
}

// The named Students' rows as they now are, in the order named: what a write answers.
async function storedRowsOf(model, where, rows) {
    const found = await prisma[model].findMany({
        where: { ...where, studentProfileId: { in: rows.map((row) => row.studentProfileId) } },
        select: textSelect,
    });
    const foundOf = new Map(found.map((row) => [row.studentProfileId, row]));
    return rows.map(({ studentProfileId }) => ({
        studentProfileId,
        text: foundOf.get(studentProfileId)?.text ?? null,
        updatedAt: foundOf.get(studentProfileId)?.updatedAt ?? null,
    }));
}

// ---------------------------------------------------------------------------
// A slot's Descriptions
// ---------------------------------------------------------------------------

// Whom a slot describes and what it holds: of the Students it reports for
// (slotReportingOf over its roster), the ones still in the School, and the Descriptions
// stored for the slot. Read by the grade view, and by finalising (ticket 04).
async function descriptionsOf(classSubject, roster, reporting) {
    const reported = roster.studentProfileIds.filter(reporting.isReportedHere);
    const [live, stored] = await Promise.all([
        prisma.studentProfile.findMany({ where: { id: { in: reported }, endedAt: null }, select: { id: true } }),
        prisma.slotDescription.findMany({ where: slotKeyOf(classSubject), select: textSelect }),
    ]);
    const described = new Set(live.map((row) => row.id));
    const storedOf = new Map(stored.map((row) => [row.studentProfileId, row]));
    return {
        stored,
        isDescribedHere: (studentProfileId) => described.has(studentProfileId),
        descriptionOf: (studentProfileId) => textView(storedOf.get(studentProfileId)),
    };
}

// Why a named Student is not this slot's to describe, for the refusal.
function notDescribedText(classSubject, roster, reporting, studentProfileId) {
    const name = roster.nameOf.get(studentProfileId);
    if (!name) return 'a student not on its roster';
    const reportedBy = reporting.classOf.get(reporting.reportingOf.get(studentProfileId));
    if (!reportedBy) return `${name} (not reported by it)`;
    if (reportedBy.id !== classSubject.classId) return `${name} (reported by ${reportedBy.name})`;
    return `${name} (no longer in the school)`;
}

// The slot's Answering Teacher - the successor once it ended - writes the Descriptions
// of Students it describes, many at once; a reader (the Homeroom Teacher, the
// Principal, a Vice Principal) is told no (403), anyone else gets 404. A Student it
// does not describe - reported by another Class's slot, gone from the School, or never
// on its roster - refuses the whole request with 400, naming each. A CLOSED Semester or
// a closed year refuses it with 409. Answers the named Students' Descriptions as they
// now are.
async function writeDescriptions(auth, id, { descriptions }) {
    const classSubject = await loadManaged(auth, id, {
        refusal: 'Only the teacher of this class subject writes its descriptions',
        kept: 'its descriptions',
    });
    const roster = await rosterOf(auth, classSubject);
    const reporting = await slotReportingOf(auth, classSubject, roster);
    const { stored, isDescribedHere } = await descriptionsOf(classSubject, roster, reporting);

    const outside = descriptions.map((row) => row.studentProfileId).filter((found) => !isDescribedHere(found));
    if (outside.length) {
        const texts = outside.map((found) => notDescribedText(classSubject, roster, reporting, found));
        throw badRequest(`${describe(classSubject)} does not describe ${listOf(texts)}`, {
            studentProfileIds: outside,
        });
    }

    const key = slotKeyOf(classSubject);
    const written = await saveTexts({
        model: 'slotDescription',
        key,
        rows: descriptions,
        stored,
        nameOf: roster.nameOf,
        userId: auth.userId,
    });
    if (written) log.info(`Descriptions of ${describe(classSubject)}: ${written} written`);
    return storedRowsOf('slotDescription', key, descriptions);
}

// ---------------------------------------------------------------------------
// A Class's Notes for a Semester
// ---------------------------------------------------------------------------

const OWN_HOMEROOM = 'The Homeroom Teacher of their own Class writes their note';

const noteClassSelect = {
    id: true,
    name: true,
    academicYearId: true,
    academicYear: { select: { label: true, status: true } },
};

// What a member is to a Class's Notes: 'writer' for its Homeroom Teacher, 'reader' for
// the Principal or a Vice Principal - the readers of the Class itself (getClass in
// academics.service.js) - and null for anyone else.
async function notesStandingOf(auth, classId) {
    if (await isHomeroomOf(auth.membershipId, classId)) return 'writer';
    if (await isPrincipalOrVice(auth.membershipId)) return 'reader';
    return null;
}

// A Class's Notes for one Semester of its year, and the caller's standing. Anyone with
// none, another school's member included, gets the same 404 as a missing Class; a
// Semester of another year is not found either.
async function loadNotes(auth, classId, semesterId) {
    const [homeroom, semester] = await Promise.all([
        prisma.class.findFirst({ where: { id: classId }, select: noteClassSelect }),
        prisma.semester.findFirst({
            where: { id: semesterId },
            select: { id: true, ordinal: true, status: true, academicYearId: true },
        }),
    ]);
    if (!homeroom) throw notFound('Class not found');
    const standing = await notesStandingOf(auth, homeroom.id);
    if (!standing) throw notFound('Class not found');
    if (!semester || semester.academicYearId !== homeroom.academicYearId) throw notFound('Semester not found');
    return { homeroom, semester, standing };
}

// The Students placed in the Class now, still in the School, by name: those whose
// Notes it writes (owner, 2026-10-17).
async function placedNowIn(classId) {
    const rows = await prisma.classMembership.findMany({
        where: { classId, endedAt: null, studentProfile: { endedAt: null } },
        select: {
            studentProfileId: true,
            studentProfile: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
        },
    });
    return new Map(rows.map((row) => [row.studentProfileId, row.studentProfile.membership.user.fullName]));
}

const notesWhere = (semester, studentProfileIds) => ({
    semesterId: semester.id,
    studentProfileId: { in: studentProfileIds },
});

// The Notes of the Students placed in the Class now, for one Semester of its year: for
// its Homeroom Teacher, the Principal and the Vice Principals. A Student who moved out
// is listed in their new Class's.
async function readNotes(auth, classId, semesterId) {
    const { homeroom, semester } = await loadNotes(auth, classId, semesterId);
    const placed = await placedNowIn(homeroom.id);
    const stored = await prisma.homeroomNote.findMany({
        where: notesWhere(semester, [...placed.keys()]),
        select: textSelect,
    });
    const storedOf = new Map(stored.map((row) => [row.studentProfileId, row]));
    return {
        class: { id: homeroom.id, name: homeroom.name },
        academicYear: homeroom.academicYear.label,
        semester: { id: semester.id, ordinal: semester.ordinal, status: semester.status },
        students: [...placed]
            .map(([studentProfileId, fullName]) => ({
                studentProfileId,
                fullName,
                note: textView(storedOf.get(studentProfileId)),
            }))
            .sort(byName),
    };
}

// The Homeroom Teacher writes the Notes of Students placed in their Class now, many at
// once; null or an empty text clears one. The Principal or a Vice Principal is told no
// (403), anyone else gets 404. A Student not placed there now refuses the whole request
// with 400, naming each: their own Class's Homeroom Teacher writes theirs. A CLOSED
// Semester or a closed year refuses it with 409. Answers the named Students' Notes as
// they now are.
async function writeNotes(auth, classId, semesterId, { notes }) {
    const { homeroom, semester, standing } = await loadNotes(auth, classId, semesterId);
    if (standing !== 'writer') throw forbidden(`Only the Homeroom Teacher of ${homeroom.name} writes its notes`);
    if (semester.status === 'CLOSED') {
        throw conflict(`Semester ${semester.ordinal} is closed; its notes stay as they are`);
    }
    const { academicYear } = homeroom;
    if (academicYear.status !== 'ACTIVE') throw conflict(`Academic year ${academicYear.label} is closed`);

    const placed = await placedNowIn(homeroom.id);
    const outside = notes.map((row) => row.studentProfileId).filter((found) => !placed.has(found));
    if (outside.length) {
        const profiles = await prisma.studentProfile.findMany({
            where: { id: { in: outside } },
            select: { id: true, membership: { select: { user: { select: { fullName: true } } } } },
        });
        const nameOf = new Map(profiles.map((row) => [row.id, row.membership.user.fullName]));
        const names = namesOf(outside, nameOf);
        throw badRequest(`Not placed in ${homeroom.name} now: ${names}. ${OWN_HOMEROOM}`, {
            studentProfileIds: outside,
        });
    }

    const ids = notes.map((row) => row.studentProfileId);
    const stored = await prisma.homeroomNote.findMany({ where: notesWhere(semester, ids), select: textSelect });
    const written = await saveTexts({
        model: 'homeroomNote',
        key: { semesterId: semester.id },
        rows: notes,
        stored,
        nameOf: placed,
        userId: auth.userId,
    });
    if (written) log.info(`Notes of ${homeroom.name}, Semester ${semester.ordinal}: ${written} written`);
    return storedRowsOf('homeroomNote', { semesterId: semester.id }, notes);
}

export { descriptionsOf, writeDescriptions, readNotes, writeNotes };
