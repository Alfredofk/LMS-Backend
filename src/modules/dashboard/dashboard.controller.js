import { ok } from '../../shared/errors.js';
import * as service from './dashboard.service.js';
import * as settings from './dashboard.settings.js';
import * as homeroom from './dashboard.homeroom.js';
import * as school from './dashboard.school.js';

// Thin, like the other controllers: the service shapes each dashboard whole.

async function getTeaching(req, res) {
    return ok(res, await service.teachingDashboard(req.auth));
}

async function getMarkingByTeacher(req, res) {
    return ok(res, await service.markingByTeacher(req.auth));
}

async function getSignalSettings(req, res) {
    return ok(res, { settings: await settings.readSignalSettings() });
}

async function setSignalSettings(req, res) {
    const saved = await settings.setSignalSettings(req.auth, req.validated.body);
    return ok(res, { settings: saved, message: 'Signal settings saved.' });
}

async function getClass(req, res) {
    return ok(res, await homeroom.classDashboard(req.auth, req.validated.params.id));
}

async function getSchool(req, res) {
    return ok(res, await school.schoolDashboard(req.auth, req.validated.query));
}

export { getTeaching, getMarkingByTeacher, getSignalSettings, setSignalSettings, getClass, getSchool };
