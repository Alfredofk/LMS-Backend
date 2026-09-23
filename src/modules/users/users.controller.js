import { ok } from '../../shared/errors.js';
import * as service from './users.service.js';

// Every handler here works on req.auth.userId and never on an id from the URL.
// There is no /users/:id in this ticket: reading another person is a membership
// question, and membership does not exist yet (tickets 04-06).

async function getMe(req, res) {
    return ok(res, await service.getMe(req.auth.userId));
}

async function updateMe(req, res) {
    return ok(res, await service.updateMe(req.auth.userId, req.validated.body));
}

async function changePassword(req, res) {
    const auth = await service.changePassword(req.auth.userId, req.validated.body, {
        rememberMe: req.auth.rememberMe,
    });
    return ok(res, {
        ...auth,
        message: 'Password changed. You are signed out on every other device.',
    });
}

export { getMe, updateMe, changePassword };
