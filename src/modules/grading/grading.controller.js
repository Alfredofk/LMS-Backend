import { ok } from '../../shared/errors.js';
import * as service from './grading.service.js';
import * as grades from './grading.grades.js';

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

export { getSchoolSettings, setSchoolSettings, getSlotSettings, setSlotSettings, clearSlotSettings, getSlotGrades };
