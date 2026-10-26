import { ok } from '../../shared/errors.js';
import * as service from './dashboard.service.js';
import * as settings from './dashboard.settings.js';

// Thin, like the other controllers: the service shapes each dashboard whole.

async function getTeaching(req, res) {
    return ok(res, await service.teachingDashboard(req.auth));
}

async function getSignalSettings(req, res) {
    return ok(res, { settings: await settings.readSignalSettings() });
}

async function setSignalSettings(req, res) {
    const saved = await settings.setSignalSettings(req.auth, req.validated.body);
    return ok(res, { settings: saved, message: 'Signal settings saved.' });
}

export { getTeaching, getSignalSettings, setSignalSettings };
