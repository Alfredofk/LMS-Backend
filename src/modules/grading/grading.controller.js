import { ok } from '../../shared/errors.js';
import * as service from './grading.service.js';
import * as grades from './grading.grades.js';
import * as texts from './grading.texts.js';
import * as finalising from './grading.finalising.js';
import * as closing from './grading.close.js';
import * as reportCards from './grading.reportCards.js';

// Thin, like the other controllers.

// ---- the school's ----

async function getSchoolSettings(_req, res) {
    return ok(res, { settings: await service.readSchoolSettings() });
}

async function setSchoolSettings(req, res) {
    const settings = await service.setSchoolSettings(req.auth, req.validated.body);
    return ok(res, { settings, message: 'Grade settings saved.' });
}

// ---- a slot's ----

async function getSlotSettings(req, res) {
    return ok(res, { settings: await service.readSlotSettings(req.auth, req.validated.params.id) });
}

async function setSlotSettings(req, res) {
    const settings = await service.setSlotSettings(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { settings, message: 'Grade settings saved.' });
}

async function clearSlotSettings(req, res) {
    const settings = await service.clearSlotSettings(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { settings, message: "The class subject follows the school's grade settings again." });
}

// ---- a slot's grades ----

async function getSlotGrades(req, res) {
    return ok(res, await grades.slotGrades(req.auth, req.validated.params.id));
}

// ---- a slot's descriptions, a Class's notes ----

async function writeDescriptions(req, res) {
    const descriptions = await texts.writeDescriptions(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { descriptions, message: 'Descriptions saved.' });
}

async function getNotes(req, res) {
    const { id, semesterId } = req.validated.params;
    return ok(res, await texts.readNotes(req.auth, id, semesterId));
}

async function writeNotes(req, res) {
    const { id, semesterId } = req.validated.params;
    const notes = await texts.writeNotes(req.auth, id, semesterId, req.validated.body);
    return ok(res, { notes, message: 'Notes saved.' });
}

// ---- finalising ----

async function startFinalising(req, res) {
    const semester = await finalising.startFinalising(req.auth, req.validated.params.id);
    return ok(res, { semester, message: 'Finalising started.' });
}

async function stopFinalising(req, res) {
    const semester = await finalising.stopFinalising(req.auth, req.validated.params.id);
    return ok(res, { semester, message: 'The semester is open again.' });
}

async function getReadiness(req, res) {
    return ok(res, await finalising.readinessBoard(req.auth, req.validated.params.id));
}

async function finalise(req, res) {
    const grades = await finalising.finalise(req.auth, req.validated.params.id);
    return ok(res, { grades, message: 'Class subject finalised.' });
}

async function unfinalise(req, res) {
    const grades = await finalising.unfinalise(req.auth, req.validated.params.id);
    return ok(res, { grades, message: 'Finalising undone.' });
}

// ---- closing, Report Cards ----

async function closeSemester(req, res) {
    const closed = await closing.closeSemester(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { ...closed, message: 'Semester closed.' });
}

async function getMyReportCards(req, res) {
    return ok(res, { reportCards: await reportCards.myReportCards(req.auth) });
}

async function getReportCard(req, res) {
    return ok(res, { reportCard: await reportCards.readReportCard(req.auth, req.validated.params.id) });
}

async function getClassReportCards(req, res) {
    const { id, semesterId } = req.validated.params;
    return ok(res, await reportCards.classReportCards(req.auth, id, semesterId));
}

export {
    getSchoolSettings,
    setSchoolSettings,
    getSlotSettings,
    setSlotSettings,
    clearSlotSettings,
    getSlotGrades,
    writeDescriptions,
    getNotes,
    writeNotes,
    startFinalising,
    stopFinalising,
    getReadiness,
    finalise,
    unfinalise,
    closeSemester,
    getMyReportCards,
    getReportCard,
    getClassReportCards,
};
