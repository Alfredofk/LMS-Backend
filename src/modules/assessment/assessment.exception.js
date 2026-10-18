import { prisma } from '../../shared/prisma.js';
import { currentPlacement } from '../../shared/guards.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { assertNotFinalised } from '../grading/grading.lock.js';
import { assertTeacherStanding, assertNotCancelled, assertWindow, describe } from './assessment.service.js';
import { exceptionSelect, exceptionOf, exceptionView, closeExpiredSubmissions } from './assessment.submission.js';
import { loadForStaff } from './assessment.marking.js';

const log = createLogger('Assessment');

// Make-up and remedial (assessment ticket 05): one Student's exception on an ONLINE
// Assessment - a make-up (susulan), their own window, for one who was sick on the
// day; extra attempts; and whether the attempts under it are a remedial.
// assessment.submission.js applies it to that Student's terms (ownTermsOf); this file
// sets, changes, removes and lists it.
//
// Owner's decisions (2026-10-04, and the build decisions of 2026-10-10):
// - Set by the Assessment's Answering Teacher, for a Student placed in its Class now
//   (currentPlacement). The Homeroom Teacher, the Principal and the Vice Principals
//   read them and change nothing (403); anyone else, another school included, 404.
// - Only on a published ONLINE Assessment not cancelled. An OFFLINE one needs none:
//   its teacher enters the make-up mark when there is one. A copy takes none along.
// - One live row per Student and Assessment, changed in place (2026-10-10); a change
//   sends back the updatedAt it read, as every write of an Assessment does.
// - A make-up's window replaces the Class's for that Student (2026-10-10), inside the
//   Semester's dates (spec invariant 4) and closing after now. Extra attempts, 0 to
//   20, add to maxAttempts, or stand alone under a remedial; the highest Score counts
//   (ticket 04).
// - It still works after release: what it produces waits for the next release
//   (answered question 2), which release() already does.
// - Changed at any time, as an Assessment's own settings are after publishing
//   (answered question 6): an attempt under way keeps its deadline, and attempts
//   lowered below those used keep what was done and start no new one. Removed only
//   while the Student has started no Submission since it was set; removed softly.
// - Whether it is a remedial is said on every set (owner, 2026-10-11): a make-up for
//   the sick, or extra attempts after a lost connection, is not one. A remedial gives
//   its extra attempts alone, at least one, whatever the Student left unused, and only
//   once the Class's window has closed with nothing of theirs in progress; one who
//   skipped may be given one too. Each attempt started under it copies the flag
//   (start()), so a later change leaves the attempts made as they were.
// - The school's remedial rule - a cap up to the KKTP, the highest, or an average - is
//   the grading slice's, read from Submission.remedial.
// - None is set, changed or removed once the slot is finalised (grading-and-report-card
//   04): 409 until its Teacher undoes the finalising (grading.lock.js).

const CHANGED_MEANWHILE = 'This exception was changed meanwhile. Reload it and try again';
const IN_USE = 'The student has started an attempt under this exception; it stays, and may be changed instead';

const staffExceptionSelect = {
    ...exceptionSelect,
    studentProfile: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
};

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

// Its Answering Teacher, on a published ONLINE Assessment not cancelled, of a slot not
// finalised.
async function loadForExceptions(auth, id) {
    const { row, standing } = await loadForStaff(auth, id);
    assertTeacherStanding(standing, 'Assessment not found');
    assertNotCancelled(row);
    if (row.mode === 'OFFLINE') {
        throw badRequest(`${describe(row)} is offline: enter the make-up mark when there is one`);
    }
    if (!row.publishedAt) throw conflict(`${describe(row)} is a draft; set exceptions once it is published`);
    await assertNotFinalised(row.classSubject);
    return row;
}

// A Student placed in the Class now, on their live profile. One placed elsewhere, one
// who left, and another school's id all get the same answer, as offline marks do.
async function assertPlacedNow(row, studentProfileId) {
    const profile = await prisma.studentProfile.findFirst({
        where: { id: studentProfileId, endedAt: null },
        select: { membershipId: true },
    });
    const placement = profile ? await currentPlacement(profile.membershipId) : null;
    if (placement?.studentProfileId !== studentProfileId || placement.classId !== row.classSubject.classId) {
        throw badRequest(`Set exceptions only for students placed in ${row.classSubject.class.name} now`, {
            studentProfileId,
        });
    }
}

// A remedial follows the Student's own go at the Assessment (owner, 2026-10-11): the
// Class's window has closed - an ONLINE one is released only then, so the Student has
// a result to remedy - and they have no attempt in progress, as acceptLate allows past
// the close. That covers one who handed in and one who did not submit, where the
// teacher tells a Student who was sick (a make-up, counted in full) from one who
// skipped it (a remedial, under the school's rule). Under a remedial only its extra
// attempts count (ownTermsOf), so before the close it would take away the Student's
// own. One past its deadline is closed first, as a start would. The Class's window,
// not a make-up's: a make-up set for one who skipped may still be turned into a
// remedial before they start it.
async function assertOriginalOver(row, studentProfileId) {
    const now = new Date();
    if (row.closesAt > now) {
        throw conflict(`${describe(row)} is still open; set a remedial once it has closed`);
    }
    await closeExpiredSubmissions({ assessmentId: row.id, studentProfileId }, now);
    const inProgress = await prisma.submission.count({
        where: { assessmentId: row.id, studentProfileId, submittedAt: null, voidedAt: null },
    });
    if (inProgress > 0) {
        throw conflict(`The student has an attempt at ${describe(row)} in progress; a remedial follows it`);
    }
}

// The exceptions among these a Student has used: started a Submission since it was
// set. A Submission started before it relied on the Class's terms.
async function usedOf(assessmentId, exceptions) {
    if (exceptions.length === 0) return new Set();
    const starts = await prisma.submission.findMany({
        where: { assessmentId, studentProfileId: { in: exceptions.map((exception) => exception.studentProfileId) } },
        select: { studentProfileId: true, startedAt: true },
    });
    const isUsed = (exception) =>
        starts.some(
            (start) => start.studentProfileId === exception.studentProfileId && start.startedAt >= exception.createdAt
        );
    return new Set(exceptions.filter(isUsed).map((exception) => exception.id));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const staffExceptionView = (row, used) => ({
    studentProfileId: row.studentProfileId,
    fullName: row.studentProfile.membership.user.fullName,
    ...exceptionView(row),
    used,
    setByUserId: row.setByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

// What a log line says of one: no Student named.
function grantNote({ makeUp, extraAttempts, remedial }) {
    const terms = [makeUp ? 'a make-up window' : '', extraAttempts ? `${extraAttempts} extra attempt(s)` : '']
        .filter(Boolean)
        .join(' and ');
    return remedial ? `a remedial (${terms})` : terms;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function readOne(assessmentId, studentProfileId) {
    const row = await prisma.assessmentException.findFirst({
        where: { assessmentId, studentProfileId, removedAt: null },
        select: staffExceptionSelect,
    });
    const used = await usedOf(assessmentId, [row]);
    return staffExceptionView(row, used.has(row.id));
}

// An Assessment's live exceptions, for its staff (staffStandingOf), by name.
async function listExceptions(auth, id) {
    const { row } = await loadForStaff(auth, id);
    const exceptions = await prisma.assessmentException.findMany({
        where: { assessmentId: row.id, removedAt: null },
        select: staffExceptionSelect,
    });
    const used = await usedOf(row.id, exceptions);
    return exceptions
        .map((exception) => staffExceptionView(exception, used.has(exception.id)))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// Sets one Student's exception, or changes the one they have: the whole of it, a
// make-up window or null, the extra attempts, and whether it is a remedial - refused
// (409) before the Class's window has closed, or while the Student has an attempt in
// progress. A change names the updatedAt it read: an older one gets 409, none 400.
// Answers with the exception.
async function setException(auth, id, studentProfileId, { makeUp, extraAttempts, remedial, updatedAt }) {
    const row = await loadForExceptions(auth, id);
    await assertPlacedNow(row, studentProfileId);
    if (makeUp) {
        await assertWindow(auth, row.classSubject, makeUp.opensAt, makeUp.closesAt);
        if (makeUp.closesAt <= new Date()) throw badRequest('A make-up window must close after now');
    }
    if (remedial) await assertOriginalOver(row, studentProfileId);

    const existing = await exceptionOf(row.id, studentProfileId);
    const data = {
        opensAt: makeUp?.opensAt ?? null,
        closesAt: makeUp?.closesAt ?? null,
        extraAttempts,
        remedial,
        setByUserId: auth.userId,
    };
    if (existing) {
        if (!updatedAt) throw badRequest('Send back the updatedAt you last read of this exception');
        if (updatedAt.getTime() !== existing.updatedAt.getTime()) throw conflict(CHANGED_MEANWHILE);
        const claimed = await prisma.assessmentException.updateMany({
            where: { id: existing.id, removedAt: null, updatedAt: existing.updatedAt },
            data,
        });
        if (claimed.count === 0) throw conflict(CHANGED_MEANWHILE);
    } else {
        // One read and removed since: the caller's view is stale.
        if (updatedAt) throw conflict(CHANGED_MEANWHILE);
        try {
            await prisma.assessmentException.create({
                data: { assessmentId: row.id, studentProfileId, ...data },
                select: { id: true },
            });
        } catch (error) {
            if (error?.code !== 'P2002') throw error;
            throw conflict('An exception was set for this student meanwhile; reload it and try again');
        }
    }

    const note = grantNote({ makeUp, extraAttempts, remedial });
    log.info(`${describe(row)}: ${note} ${existing ? 'changed' : 'set'} for a student`);
    return readOne(row.id, studentProfileId);
}

// Takes one Student's exception back, softly, while they have started nothing under
// it. One they used stays, to be changed instead. The claim repeats the check, so a
// Student starting at the same moment wins.
async function removeException(auth, id, studentProfileId) {
    const row = await loadForExceptions(auth, id);
    const exception = await exceptionOf(row.id, studentProfileId);
    if (!exception) throw notFound('Exception not found');
    if ((await usedOf(row.id, [exception])).size > 0) throw conflict(IN_USE);

    const claimed = await prisma.assessmentException.updateMany({
        where: {
            id: exception.id,
            removedAt: null,
            studentProfile: {
                submissions: { none: { assessmentId: row.id, startedAt: { gte: exception.createdAt } } },
            },
        },
        data: { removedAt: new Date(), removedByUserId: auth.userId },
    });
    if (claimed.count === 0) {
        throw (await exceptionOf(row.id, studentProfileId)) ? conflict(IN_USE) : notFound('Exception not found');
    }
    log.info(`${describe(row)}: an exception removed for a student`);
}

export { listExceptions, setException, removeException };
