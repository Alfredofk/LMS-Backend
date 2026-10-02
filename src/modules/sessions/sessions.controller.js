import { ok } from '../../shared/errors.js';
import * as service from './sessions.service.js';

// Thin, like the other controllers.

async function setSchedule(req, res) {
    const schedule = await service.setSchedule(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { schedule });
}

async function getSchedule(req, res) {
    return ok(res, { schedule: await service.getSchedule(req.auth, req.validated.params.id) });
}

async function listSessions(req, res) {
    const sessions = await service.listSessions(req.auth, req.validated.params.id, req.validated.query);
    return ok(res, { sessions });
}

async function listMine(req, res) {
    return ok(res, await service.listMine(req.auth, req.validated.query));
}

async function listNeedingCompletion(req, res) {
    return ok(res, { sessions: await service.listNeedingCompletion(req.auth) });
}

async function markNotHeld(req, res) {
    return ok(res, { session: await service.markNotHeld(req.auth, req.validated.params.id) });
}

export { setSchedule, getSchedule, listSessions, listMine, listNeedingCompletion, markNotHeld };
