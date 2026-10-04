import { ok } from '../../shared/errors.js';
import * as service from './tracking.service.js';

// Thin, like the other controllers. Always 200: the answer is per event.

async function recordEvents(req, res) {
    return ok(res, await service.recordClientEvents(req.auth, req.validated.body));
}

export { recordEvents };
