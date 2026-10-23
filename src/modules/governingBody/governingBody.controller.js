import { ok } from '../../shared/errors.js';
import * as service from './governingBody.service.js';

// Thin by design, like school.controller.js: read what validation produced, call the
// service, wrap the answer in the envelope (governing-body ticket 03).

// ---- applicant --------------------------------------------------------------

async function submit(req, res) {
    const registration = await service.submitRegistration(req.auth.userId, req.validated.body, req.files);
    return ok(
        res,
        { registration, message: 'Registration submitted. A platform admin will review it.' },
        201
    );
}

async function listMine(req, res) {
    return ok(res, { registrations: await service.listMine(req.auth.userId) });
}

// ---- platform admin: registrations -----------------------------------------

const reviewer = (req) => ({ adminId: req.platformAdminId, adminUserId: req.auth.userId });

// Registrations, the filtered total and the tab counts, spread as the School queue's.
async function list(req, res) {
    return ok(res, await service.listRegistrations(req.validated.query));
}

async function get(req, res) {
    return ok(res, { registration: await service.getRegistration(req.validated.params.id) });
}

// File bytes, the one answer outside the envelope.
const sendFile = (which) => async (req, res) => {
    const { buffer, contentType } = await service.readFile(req.validated.params.id, which);
    res.set({ 'Content-Type': contentType, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return res.send(buffer);
};

const ktp = sendFile('ktp');
const proof = sendFile('proof');

async function approve(req, res) {
    const registration = await service.approveRegistration(req.validated.params.id, reviewer(req));
    return ok(res, { registration, message: 'Approved. The governing body exists and its first admin is active.' });
}

async function reject(req, res) {
    const registration = await service.rejectRegistration(req.validated.params.id, {
        ...reviewer(req),
        reason: req.validated.body.reason,
    });
    return ok(res, { registration, message: 'Rejected. Both files were discarded.' });
}

// ---- platform admin: a body -------------------------------------------------

async function update(req, res) {
    const { params, body } = req.validated;
    const governingBody = await service.updateGoverningBody(req.auth.userId, params.id, body);
    return ok(res, { governingBody, message: 'Corrected.' });
}

async function deactivate(req, res) {
    const governingBody = await service.deactivateGoverningBody(req.validated.params.id, {
        ...reviewer(req),
        reason: req.validated.body.reason,
    });
    return ok(res, {
        governingBody,
        message: 'Deactivated. Its admins have lost access; its schools keep running; nothing was deleted.',
    });
}

async function reactivate(req, res) {
    const governingBody = await service.reactivateGoverningBody(req.validated.params.id, {
        adminUserId: req.auth.userId,
        reason: req.validated.body.reason,
    });
    return ok(res, { governingBody, message: 'Reactivated. Its admins sign in again.' });
}

// ---- the seat ---------------------------------------------------------------

async function own(req, res) {
    return ok(res, { governingBody: await service.ownGoverningBody(req.auth) });
}

export { submit, listMine, list, get, ktp, proof, approve, reject, update, deactivate, reactivate, own };
