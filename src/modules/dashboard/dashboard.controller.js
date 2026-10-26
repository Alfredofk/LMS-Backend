import { ok } from '../../shared/errors.js';
import * as service from './dashboard.service.js';

// Thin, like the other controllers: the service shapes each dashboard whole.

async function getTeaching(req, res) {
    return ok(res, await service.teachingDashboard(req.auth));
}

export { getTeaching };
