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

// What was kept is said in the answer itself (UU PDP Pasal 45): the person is told
// that deletion happened, and that their name stays on the school's records.
async function deleteMe(req, res) {
    const result = await service.deleteAccount(req.auth.userId, req.validated.body);
    return ok(res, {
        ...result,
        message:
            'Your account is deleted and you are signed out everywhere. Your sign-in details and ' +
            'phone number are gone and the email address is free to register again. Your name stays on the ' +
            'records of any school you belonged to, which keeps them.',
    });
}

export { getMe, updateMe, changePassword, deleteMe };
