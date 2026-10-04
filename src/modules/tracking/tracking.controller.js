import { ok } from '../../shared/errors.js';
import * as service from './tracking.service.js';

// Thin, like the other controllers. Recording always answers 200: the answer is
// per event.

async function recordEvents(req, res) {
    return ok(res, await service.recordClientEvents(req.auth, req.validated.body));
}

async function getClassSubjectProgress(req, res) {
    return ok(res, await service.classSubjectProgress(req.auth, req.validated.params.id));
}

async function getOwnProgress(req, res) {
    return ok(res, await service.ownProgress(req.auth));
}

export { recordEvents, getClassSubjectProgress, getOwnProgress };
