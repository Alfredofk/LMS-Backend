import { ok } from '../../shared/errors.js';
import * as service from './attendance.service.js';

// Thin, like the other controllers.

async function checkIn(req, res) {
    const result = await service.checkIn(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, result, 201);
}

async function confirm(req, res) {
    const roster = await service.confirm(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { ...roster, message: 'Attendance confirmed.' });
}

async function getRoster(req, res) {
    return ok(res, await service.rosterView(req.auth, req.validated.params.id));
}

async function correct(req, res) {
    const attendance = await service.correct(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { attendance });
}

async function history(req, res) {
    return ok(res, await service.history(req.auth, req.validated.params.id));
}

async function mine(req, res) {
    return ok(res, { attendance: await service.mine(req.auth, req.validated.query) });
}

export { checkIn, confirm, getRoster, correct, history, mine };
