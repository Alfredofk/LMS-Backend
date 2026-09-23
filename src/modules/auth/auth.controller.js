import { ok } from '../../shared/errors.js';
import * as service from './auth.service.js';

// Thin by design: read req.validated, call the service, wrap in the envelope.
// Every decision worth arguing about lives in auth.service.js.
//
// No try/catch anywhere here. Express 5 forwards a rejected promise from an async
// handler to the error handler on its own, which is exactly what server.js:56
// is waiting for. Wrapping these in try/catch would only duplicate it.

// The same wording whether or not the address turned out to exist.
const SILENT_REPLY = {
    message: 'If that email address has an account, we have sent it a message.',
};

async function register(req, res) {
    const user = await service.registerUser(req.validated.body);
    return ok(
        res,
        { user, message: 'Account created. Check your email for the verification link.' },
        201
    );
}

// GET, called by the web app's /verify-email page - the page the email links to.
// Opening that page is the verification; nothing else is asked of the user.
async function verifyEmail(req, res) {
    const { alreadyVerified } = await service.verifyEmail(req.validated.query.token);
    return ok(res, {
        verified: true,
        message: alreadyVerified
            ? 'This address was already verified. You can sign in.'
            : 'Email verified. You can sign in now.',
    });
}

async function resendVerification(req, res) {
    await service.resendVerification(req.validated.body.email);
    return ok(res, SILENT_REPLY);
}

async function login(req, res) {
    return ok(res, await service.login(req.validated.body));
}

async function googleSignIn(req, res) {
    return ok(res, await service.googleSignIn(req.validated.body));
}

async function refresh(req, res) {
    return ok(res, await service.refreshAuth(req.validated.body.refreshToken));
}

async function logout(req, res) {
    await service.logout(req.validated.body.refreshToken);
    return ok(res, { message: 'Signed out.' });
}

async function forgotPassword(req, res) {
    await service.forgotPassword(req.validated.body.email);
    return ok(res, SILENT_REPLY);
}

// GET, called by the web app's /reset-password page before it shows the form.
// Tells the client whether the form is worth rendering; changes nothing.
async function checkResetToken(req, res) {
    return ok(res, await service.checkResetToken(req.validated.query.token));
}

async function resetPassword(req, res) {
    await service.resetPassword(req.validated.body);
    return ok(res, {
        message: 'Password changed. You are signed out on every other device.',
    });
}

export {
    register,
    verifyEmail,
    resendVerification,
    login,
    googleSignIn,
    refresh,
    logout,
    forgotPassword,
    checkResetToken,
    resetPassword,
};
