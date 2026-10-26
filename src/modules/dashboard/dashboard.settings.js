import { prisma } from '../../shared/prisma.js';
import { assertPrincipalOrVice } from '../../shared/guards.js';
import { recordAudit } from '../../shared/approval.js';
import { badRequest, conflict } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('Dashboard');

// The School's Support Signal thresholds (dashboard ticket 02, the spec's D2): the numbers
// dashboard.signals.js raises each signal at.
//
// Owner's decisions (2026-10-26, the spec; 2026-10-27, the plan, through the picker):
// - Five signal types, fixed in code; only their thresholds change, per School over
//   built-in ones, as the grade settings' do (grading.service.js). Not handoff #29's
//   table of free rules.
// - Read by the School's staff; set by the Principal or a Vice Principal, audited
//   UPDATE_SIGNAL_SETTINGS against the School, one line per change.
// - A value sent as null goes back to the built-in one, one at a time; there is no
//   DELETE.
// - Every write sends back the updatedAt it read (the 2026-10-09 convention).
// - Below the KKTP has no threshold of its own: it is the slot's KKTP (grading).

// What applies where the School has set nothing (owner, 2026-10-26).
const BUILT_IN = {
    absenceCount: 3,
    absenceWindowDays: 14,
    contentBehindPercent: 50,
    contentBehindMinPublished: 4,
    notSubmittedCount: 2,
    inactiveDays: 7,
};

const THRESHOLD_KEYS = Object.keys(BUILT_IN);

// For the audit's lines: 'absences 3 (built in) -> 4'.
const THRESHOLD_NAMES = {
    absenceCount: 'absences',
    absenceWindowDays: 'absence window (days)',
    contentBehindPercent: 'content behind (%)',
    contentBehindMinPublished: 'Content published before content behind counts',
    notSubmittedCount: 'not submitted',
    inactiveDays: 'inactive (days)',
};

// The School's settings are audited against the School, as its grade settings are.
const SCHOOL_SUBJECT = 'School';

const CHANGED_MEANWHILE = 'The signal settings were changed meanwhile. Reload them and try again';
const SEND_UPDATED_AT = 'Send back the updatedAt you last read of these signal settings';

const ownSelect = {
    id: true,
    ...Object.fromEntries(THRESHOLD_KEYS.map((key) => [key, true])),
    updatedAt: true,
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// Each threshold as it applies, and where it comes from: the School's own, or BUILT_IN
// for "not set by the School".
const settingsFrom = (row) =>
    Object.fromEntries(
        THRESHOLD_KEYS.map((key) => [
            key,
            (row?.[key] ?? null) !== null
                ? { value: row[key], source: 'SCHOOL' }
                : { value: BUILT_IN[key], source: 'BUILT_IN' },
        ])
    );

// What a read answers: each threshold with its source, and the updatedAt a write sends
// back - the row's, or null while nothing was saved.
const settingsView = (row) => ({ ...settingsFrom(row), updatedAt: row?.updatedAt ?? null });

const textOf = (setting) => `${setting.value}${setting.source === 'BUILT_IN' ? ' (built in)' : ''}`;

// What a write changes, one line per threshold: its value, or where it comes from. Empty
// when it changes nothing.
function changesOf(before, after) {
    return THRESHOLD_KEYS.map((key) => [key, textOf(before[key]), textOf(after[key])])
        .filter(([, from, to]) => from !== to)
        .map(([key, from, to]) => `${THRESHOLD_NAMES[key]} ${from} -> ${to}`);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const schoolRowOf = () => prisma.schoolSignalSetting.findFirst({ select: ownSelect });

// GET /api/dashboard/signal-settings, for the School's staff.
async function readSignalSettings() {
    return settingsView(await schoolRowOf());
}

// The values the signals are raised with now, for the dashboards.
async function thresholdsOf() {
    const settings = settingsFrom(await schoolRowOf());
    return Object.fromEntries(THRESHOLD_KEYS.map((key) => [key, settings[key].value]));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// The 2026-10-09 convention, as grading.service.js keeps it for the grade settings: a row
// that exists takes the updatedAt read - none sent gets 400, an older one 409. Before the
// first save there is none to send; one sent then was read of nothing. A null says the
// caller read no row, so a row saved since is 409 too: two first saves at once get 200 and
// 409 however they interleave.
function assertSeen(row, updatedAt) {
    if (!row) {
        if (updatedAt) throw conflict(CHANGED_MEANWHILE);
        return;
    }
    if (updatedAt === undefined) throw badRequest(SEND_UPDATED_AT);
    if (updatedAt === null || updatedAt.getTime() !== row.updatedAt.getTime()) throw conflict(CHANGED_MEANWHILE);
}

// PUT /api/dashboard/signal-settings. The Principal or a Vice Principal sets any of the
// thresholds, null putting one back to the built-in value; a Teacher gets 403. Saved over
// the row read (a claim on its updatedAt; two first saves at once meet on the unique
// schoolId) and audited in the same transaction. A save that changes nothing writes
// nothing.
async function setSignalSettings(auth, body) {
    await assertPrincipalOrVice(auth);
    const row = await schoolRowOf();
    assertSeen(row, body.updatedAt);

    const data = Object.fromEntries(
        THRESHOLD_KEYS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]])
    );
    const changes = changesOf(settingsFrom(row), settingsFrom({ ...row, ...data }));
    if (changes.length === 0) return settingsView(row);

    try {
        await prisma.$transaction(async (tx) => {
            if (row) {
                const claimed = await tx.schoolSignalSetting.updateMany({
                    where: { id: row.id, updatedAt: row.updatedAt },
                    data: { ...data, setByUserId: auth.userId },
                });
                if (claimed.count === 0) throw conflict(CHANGED_MEANWHILE);
            } else {
                await tx.schoolSignalSetting.create({
                    data: { ...data, setByUserId: auth.userId },
                    select: { id: true },
                });
            }
            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: SCHOOL_SUBJECT,
                subjectId: auth.schoolId,
                action: 'UPDATE_SIGNAL_SETTINGS',
                actorUserId: auth.userId,
                reason: changes.join('; '),
                client: tx,
            });
        });
    } catch (error) {
        throw error?.code === 'P2002' ? conflict(CHANGED_MEANWHILE) : error;
    }

    log.info(`Signal settings at ${auth.schoolName}: ${changes.join('; ')}`);
    return readSignalSettings();
}

export { readSignalSettings, thresholdsOf, setSignalSettings };
