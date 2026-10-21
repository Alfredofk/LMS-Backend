import { prisma } from '../../shared/prisma.js';
import { assertPrincipalOrVice } from '../../shared/guards.js';
import { recordAudit } from '../../shared/approval.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { staffStandingOf } from '../sessions/sessions.service.js';
import { TYPES } from './grading.compute.js';
import { slotNameOf, liveFinalisationOf, assertNotFinalised } from './grading.lock.js';

const log = createLogger('Grading');

// Grade settings (grading-and-report-card ticket 01): the numbers every Final Grade is
// computed with - the Grade Weight of each Assessment type, the KKTP, and the
// school's Remedial Rule. Ticket 02 reads them through slotSettingsOf. This module
// reads Scores and never writes one (spec invariant 2).
//
// Owner's decisions (2026-10-13, the spec and the build decisions on the plan):
// - The school's defaults - the four weights and the KKTP - and its Remedial Rule are
//   set by the Principal or a Vice Principal: academic machinery (ADR-0009). Each
//   change is audited UPDATE_GRADE_SETTINGS, against the school.
// - Before the school sets one, a built-in default applies: 25/25/25/25, KKTP 75, the
//   cap up to the KKTP. A read says where each value comes from, BUILT_IN being "not
//   set by the school".
// - A slot (Class x Subject x Semester) may have its own weights and KKTP, each apart,
//   set by its Answering Teacher until it is finalised (ticket 04, grading.lock.js). A
//   value it has none of follows the school's. An ended assignment and its successor
//   share the slot's row. Not audited: the row says who saved it last.
// - A finalised slot reads the settings it was finalised with - the Remedial Rule too -
//   so a later change to the school's defaults moves no finalised grade (owner,
//   2026-10-18). Undone, it follows the live ones again.
// - Clearing a slot's own values nulls them, and the row stays: nothing is deleted.
// - A slot in a CLOSED Semester, or a closed year, takes no change.
// - Every write sends back the updatedAt it read (the 2026-10-09 convention).
// - The school also chooses whether its printed Report Card carries a blank
//   Extracurricular table and a blank Personality table (ticket 08, owner 2026-10-20):
//   the same writers and audit as its defaults, neither before it chooses, and frozen
//   onto each Report Card at close. A slot has no say in them.

const WEIGHT_COLUMNS = { TUGAS: 'weightTugas', KUIS: 'weightKuis', UTS: 'weightUts', UAS: 'weightUas' };

// What applies where the school has set nothing (owner, 2026-10-13).
const BUILT_IN = {
    weights: { TUGAS: 25, KUIS: 25, UTS: 25, UAS: 25 },
    kktp: 75,
    remedialRule: 'CAP_AT_KKTP',
};

// The school's settings are audited against the school, as its other settings are
// (location, time zone, joint leave, subjects).
const SCHOOL_SUBJECT = 'School';

const CHANGED_MEANWHILE = 'The grade settings were changed meanwhile. Reload them and try again';
const SEND_UPDATED_AT = 'Send back the updatedAt you last read of these grade settings';

const ownSelect = {
    id: true,
    weightTugas: true,
    weightKuis: true,
    weightUts: true,
    weightUas: true,
    kktp: true,
    updatedAt: true,
};

const classSubjectSelect = {
    id: true,
    status: true,
    endedAt: true,
    classId: true,
    subjectId: true,
    semesterId: true,
    teacherMembershipId: true,
    // The year for who gets a Report Card (ticket 05).
    class: { select: { name: true, academicYearId: true, academicYear: { select: { label: true, status: true } } } },
    subject: { select: { code: true, name: true } },
    // The dates for the slot's roster and span (ticket 02).
    semester: { select: { ordinal: true, status: true, startDate: true, endDate: true } },
};

// 'MTK in 7A, Semester 1', for messages and log lines.
const describe = slotNameOf;

// ---------------------------------------------------------------------------
// The values and where they come from
// ---------------------------------------------------------------------------

// A row's four weights, set and cleared together, or null when it has none of its own.
const weightsOf = (row) =>
    (row?.weightTugas ?? null) === null
        ? null
        : Object.fromEntries(TYPES.map((type) => [type, row[WEIGHT_COLUMNS[type]]]));

// The four columns for a body's weights; null clears them.
const weightColumnsOf = (weights) =>
    Object.fromEntries(TYPES.map((type) => [WEIGHT_COLUMNS[type], weights?.[type] ?? null]));

// A value as it applies, and the level it comes from: the first of the levels, from
// the slot down, that has one of its own. BUILT_IN always has.
function firstOwn(levels) {
    const [source, value] = levels.find(([, own]) => (own ?? null) !== null);
    return { value, source };
}

// The settings as they apply to a slot, or to the school alone when slotRow is null.
// The Remedial Rule is the school's only (owner, 2026-10-13).
function settingsFrom(slotRow, schoolRow) {
    return {
        weights: firstOwn([
            ['SLOT', weightsOf(slotRow)],
            ['SCHOOL', weightsOf(schoolRow)],
            ['BUILT_IN', { ...BUILT_IN.weights }],
        ]),
        kktp: firstOwn([
            ['SLOT', slotRow?.kktp],
            ['SCHOOL', schoolRow?.kktp],
            ['BUILT_IN', BUILT_IN.kktp],
        ]),
        remedialRule: firstOwn([
            ['SCHOOL', schoolRow?.remedialRule],
            ['BUILT_IN', BUILT_IN.remedialRule],
        ]),
    };
}

// The printed Report Card's two blank tables as the school chose them (ticket 08), or
// neither before it chose.
const tablesFrom = (schoolRow) => ({
    extracurricularTable: firstOwn([
        ['SCHOOL', schoolRow?.extracurricularTable],
        ['BUILT_IN', false],
    ]),
    personalityTable: firstOwn([
        ['SCHOOL', schoolRow?.personalityTable],
        ['BUILT_IN', false],
    ]),
});

// Everything the school sets: its defaults, its Remedial Rule and the tables.
const schoolSettingsFrom = (schoolRow) => ({ ...settingsFrom(null, schoolRow), ...tablesFrom(schoolRow) });

// What a read answers: each setting with its source, and the updatedAt a write sends
// back - the row's, or null while nothing was saved.
const settingsView = (settings, row) => ({ ...settings, updatedAt: row?.updatedAt ?? null });

const SETTING_NAMES = {
    weights: 'weights',
    kktp: 'KKTP',
    remedialRule: 'remedial rule',
    extracurricularTable: 'extracurricular table',
    personalityTable: 'personality table',
};
const SOURCE_NOTES = { SCHOOL: " (the school's)", BUILT_IN: ' (built in)' };

// '20/20/25/35', 'on', or '75 (built in)' where a value is not the writer's level's own.
function textOf(key, setting, own) {
    let value = setting.value;
    if (key === 'weights') value = TYPES.map((type) => setting.value[type]).join('/');
    if (typeof value === 'boolean') value = value ? 'on' : 'off';
    return `${value}${setting.source === own ? '' : SOURCE_NOTES[setting.source]}`;
}

// What a write changes, one line per setting it has - a slot has no tables: its value, or
// the level it comes from. 'weights 25/25/25/25 (built in) -> 20/20/25/35'. Empty when it
// changes nothing.
function changesOf(before, after, own) {
    return Object.keys(SETTING_NAMES)
        .filter((key) => key in before)
        .map((key) => [key, textOf(key, before[key], own), textOf(key, after[key], own)])
        .filter(([, from, to]) => from !== to)
        .map(([key, from, to]) => `${SETTING_NAMES[key]} ${from} -> ${to}`);
}

// ---------------------------------------------------------------------------
// Access and the rows
// ---------------------------------------------------------------------------

async function loadClassSubject(id) {
    const row = await prisma.classSubject.findFirst({ where: { id }, select: classSubjectSelect });
    if (!row) throw notFound('Class subject not found');
    return row;
}

// A slot's staff read its settings (staffStandingOf); anyone else, another school's
// member included, gets the same 404 as a missing one.
async function loadForStaff(auth, id) {
    const classSubject = await loadClassSubject(id);
    const standing = await staffStandingOf(auth, classSubject);
    if (!standing) throw notFound('Class subject not found');
    return { classSubject, standing };
}

// Its Answering Teacher changes them - the successor once it ended; a reader, a Vice
// Principal included, is told no (403). A CLOSED Semester, a closed year, or the slot
// finalised (ticket 04) takes no change (409). The Descriptions (ticket 03,
// grading.texts.js) are the slot's under the same rule, in their own words.
async function loadManaged(
    auth,
    id,
    { refusal = 'Only the teacher of this class subject sets its weights and KKTP', kept = 'its grade settings' } = {}
) {
    const { classSubject, standing } = await loadForStaff(auth, id);
    if (standing !== 'teacher') throw forbidden(refusal);
    const { semester } = classSubject;
    const { academicYear } = classSubject.class;
    if (semester.status === 'CLOSED') {
        throw conflict(`Semester ${semester.ordinal} is closed; ${kept} stay as they are`);
    }
    if (academicYear.status !== 'ACTIVE') throw conflict(`Academic year ${academicYear.label} is closed`);
    await assertNotFinalised(classSubject);
    return classSubject;
}

const schoolRowOf = () =>
    prisma.schoolGradeSetting.findFirst({
        select: { ...ownSelect, remedialRule: true, extracurricularTable: true, personalityTable: true },
    });

const slotKeyOf = (classSubject) => ({
    classId: classSubject.classId,
    subjectId: classSubject.subjectId,
    semesterId: classSubject.semesterId,
});

const slotRowOf = (classSubject) =>
    prisma.slotGradeSetting.findFirst({ where: slotKeyOf(classSubject), select: ownSelect });

// Every change is made to the version its caller read (frontend note #12, the
// 2026-10-09 convention): a row that exists takes the updatedAt read - none gets 400,
// an older one 409. Before the first save there is none to send; one sent then was
// read of nothing.
function assertSeen(row, updatedAt) {
    if (!row) {
        if (updatedAt) throw conflict(CHANGED_MEANWHILE);
        return;
    }
    if (!updatedAt) throw badRequest(SEND_UPDATED_AT);
    if (updatedAt.getTime() !== row.updatedAt.getTime()) throw conflict(CHANGED_MEANWHILE);
}

// Saves over the row its caller read: a claim on its updatedAt, so a save landing
// between the read and this one wins and this one gets 409. With no row yet it writes
// the first; two first saves at once meet on the unique key (raceLost).
async function saveSeen(delegate, row, data, key = {}) {
    if (row) {
        const claimed = await delegate.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data });
        if (claimed.count === 0) throw conflict(CHANGED_MEANWHILE);
        return;
    }
    await delegate.create({ data: { ...key, ...data }, select: { id: true } });
}

const raceLost = (error) => (error?.code === 'P2002' ? conflict(CHANGED_MEANWHILE) : error);

// ---------------------------------------------------------------------------
// The school's
// ---------------------------------------------------------------------------

// The school's defaults, its Remedial Rule and its Report Card's tables, for its staff.
async function readSchoolSettings() {
    const row = await schoolRowOf();
    return settingsView(schoolSettingsFrom(row), row);
}

// The Principal or a Vice Principal sets the school's default weights, its default
// KKTP, its Remedial Rule, its Report Card's tables (ticket 08), or any of them at once;
// a Teacher gets 403. Audited in the same transaction, one line per change. A save that
// changes nothing writes nothing.
async function setSchoolSettings(
    auth,
    { weights, kktp, remedialRule, extracurricularTable, personalityTable, updatedAt }
) {
    await assertPrincipalOrVice(auth);
    const row = await schoolRowOf();
    assertSeen(row, updatedAt);

    const data = {};
    if (weights) Object.assign(data, weightColumnsOf(weights));
    if (kktp !== undefined) data.kktp = kktp;
    if (remedialRule) data.remedialRule = remedialRule;
    if (extracurricularTable !== undefined) data.extracurricularTable = extracurricularTable;
    if (personalityTable !== undefined) data.personalityTable = personalityTable;
    const changes = changesOf(schoolSettingsFrom(row), schoolSettingsFrom({ ...row, ...data }), 'SCHOOL');
    if (changes.length === 0) return settingsView(schoolSettingsFrom(row), row);

    try {
        await prisma.$transaction(async (tx) => {
            await saveSeen(tx.schoolGradeSetting, row, { ...data, setByUserId: auth.userId });
            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: SCHOOL_SUBJECT,
                subjectId: auth.schoolId,
                action: 'UPDATE_GRADE_SETTINGS',
                actorUserId: auth.userId,
                reason: changes.join('; '),
                client: tx,
            });
        });
    } catch (error) {
        throw raceLost(error);
    }

    log.info(`Grade settings at ${auth.schoolName}: ${changes.join('; ')}`);
    return readSchoolSettings();
}

// Which blank tables the school's Report Cards carry, as the close freezes them
// (ticket 08): { extracurricularTable, personalityTable }.
async function reportCardTablesOf() {
    const tables = tablesFrom(await schoolRowOf());
    return {
        extracurricularTable: tables.extracurricularTable.value,
        personalityTable: tables.personalityTable.value,
    };
}

// ---------------------------------------------------------------------------
// A slot's
// ---------------------------------------------------------------------------

// The settings a finalisation kept (ticket 04), read back from their JSON column with
// the weights in the order every view lists the types: jsonb keeps keys its own way.
const keptSettingsOf = (kept) => ({
    ...kept,
    weights: { ...kept.weights, value: Object.fromEntries(TYPES.map((type) => [type, kept.weights.value[type]])) },
});

// The settings a slot's grades are computed with, each with its source, and the
// updatedAt of the slot's own row. Named by any ClassSubject of the slot. Finalised
// (ticket 04), the ones it was finalised with.
async function slotSettingsOf(classSubject) {
    const [slotRow, schoolRow, finalisation] = await Promise.all([
        slotRowOf(classSubject),
        schoolRowOf(),
        liveFinalisationOf(classSubject),
    ]);
    const settings = finalisation ? keptSettingsOf(finalisation.settings) : settingsFrom(slotRow, schoolRow);
    return settingsView(settings, slotRow);
}

async function readSlotSettings(auth, id) {
    const { classSubject } = await loadForStaff(auth, id);
    return slotSettingsOf(classSubject);
}

// Saves a slot's own values over the version its caller read, and answers with the
// settings as they now apply. A save that changes nothing writes nothing.
async function saveSlot(auth, classSubject, data, updatedAt) {
    const [slotRow, schoolRow] = await Promise.all([slotRowOf(classSubject), schoolRowOf()]);
    assertSeen(slotRow, updatedAt);

    const before = settingsFrom(slotRow, schoolRow);
    const changes = changesOf(before, settingsFrom({ ...slotRow, ...data }, schoolRow), 'SLOT');
    if (changes.length === 0) return settingsView(before, slotRow);

    const saved = { ...data, setByUserId: auth.userId };
    try {
        await saveSeen(prisma.slotGradeSetting, slotRow, saved, slotKeyOf(classSubject));
    } catch (error) {
        throw raceLost(error);
    }

    log.info(`Grade settings of ${describe(classSubject)}: ${changes.join('; ')}`);
    return slotSettingsOf(classSubject);
}

// The Answering Teacher sets the slot's own weights, its own KKTP, or both; null puts
// one back to the school's.
async function setSlotSettings(auth, id, { weights, kktp, updatedAt }) {
    const classSubject = await loadManaged(auth, id);
    const data = {};
    if (weights !== undefined) Object.assign(data, weightColumnsOf(weights));
    if (kktp !== undefined) data.kktp = kktp;
    return saveSlot(auth, classSubject, data, updatedAt);
}

// The Answering Teacher puts the slot back to the school's settings, all of them.
async function clearSlotSettings(auth, id, { updatedAt }) {
    const classSubject = await loadManaged(auth, id);
    return saveSlot(auth, classSubject, { ...weightColumnsOf(null), kktp: null }, updatedAt);
}

export {
    classSubjectSelect,
    describe,
    loadForStaff,
    loadManaged,
    slotKeyOf,
    readSchoolSettings,
    setSchoolSettings,
    reportCardTablesOf,
    slotSettingsOf,
    readSlotSettings,
    setSlotSettings,
    clearSlotSettings,
};
