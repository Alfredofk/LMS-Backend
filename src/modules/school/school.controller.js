import { ok } from '../../shared/errors.js';
import * as service from './school.service.js';

// Thin by design, like auth.controller.js: read what validation produced, call
// the service, wrap the answer in the envelope. No try/catch - Express 5 hands a
// rejected promise to the error handler in server.js on its own.

// ---- applicant --------------------------------------------------------------

async function submit(req, res) {
    const registration = await service.submitRegistration(
        req.auth.userId,
        req.validated.body,
        req.file
    );
    return ok(
        res,
        { registration, message: 'Registration submitted. A platform admin will review it.' },
        201
    );
}

async function listMine(req, res) {
    return ok(res, { registrations: await service.listMine(req.auth.userId) });
}

// ---- platform admin ---------------------------------------------------------

const reviewer = (req) => ({ adminId: req.platformAdminId, adminUserId: req.auth.userId });

// The service already answers in the shape the screen wants - registrations, the
// filtered total, and the unfiltered per-status counts the tab badges are made of -
// so it is spread rather than wrapped. `registrations` keeps its name, which is
// what the existing frontend reads.
async function list(req, res) {
    return ok(res, await service.listRegistrations(req.validated.query));
}

async function get(req, res) {
    return ok(res, { registration: await service.getRegistration(req.validated.params.id) });
}

// The one response in the API that is not the JSON envelope: it is the image
// itself, for the admin's browser to show. no-store because it is a national ID
// document, and it must not linger in a cache after the file is deleted.
async function ktp(req, res) {
    const { buffer, contentType } = await service.readKtp(req.validated.params.id);
    res.set({
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
    });
    return res.send(buffer);
}

async function approve(req, res) {
    const registration = await service.approveRegistration(req.validated.params.id, reviewer(req));
    return ok(res, { registration, message: 'Approved. The school exists and its Principal is active.' });
}

async function reject(req, res) {
    const registration = await service.rejectRegistration(req.validated.params.id, {
        ...reviewer(req),
        reason: req.validated.body.reason,
    });
    return ok(res, { registration, message: 'Rejected.' });
}

// Withdrawing an approved school's access, and giving it back. Both answer with
// the registration, like approve and reject, because that is the row the admin
// screen is holding - and `registration.school.deactivatedAt` is how it can tell
// which way this went.
async function deactivate(req, res) {
    const registration = await service.deactivateSchool(req.validated.params.id, {
        ...reviewer(req),
        reason: req.validated.body.reason,
    });
    return ok(res, {
        registration,
        message: 'Deactivated. Every member has lost access; nothing was deleted.',
    });
}

async function reactivate(req, res) {
    const registration = await service.reactivateSchool(req.validated.params.id, {
        ...reviewer(req),
        reason: req.validated.body.reason,
    });
    return ok(res, {
        registration,
        message: 'Reactivated. Members have to sign in again.',
    });
}

// ---- principal --------------------------------------------------------------

async function rotateCode(req, res) {
    const school = await service.rotateSchoolCode(req.auth);
    return ok(res, {
        school,
        message: 'New School Code issued. The old one no longer works; pending requests are unaffected.',
    });
}

export { submit, listMine, list, get, ktp, approve, reject, deactivate, reactivate, rotateCode };
