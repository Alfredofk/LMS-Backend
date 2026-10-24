import { ok } from '../../shared/errors.js';
import * as service from './governingBody.service.js';
import * as admins from './governingBody.admins.js';
import { changeGoverningBodySubdomain } from '../school/school.subdomain.js';

// Thin by design, like school.controller.js: read what validation produced, call the
// service, wrap the answer in the envelope (governing-body tickets 03 and 04).

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

// ---- applicant: the Governing Body Code (ticket 04) -------------------------

async function lookup(req, res) {
    return ok(res, { governingBody: await service.lookupGoverningBody(req.auth.userId, req.validated.body) });
}

async function applyAsAdmin(req, res) {
    const seat = await admins.applyAsAdmin(req.auth.userId, req.validated.body);
    return ok(res, { seat, message: 'Application sent. The senior admin will decide it.' }, 201);
}

async function listOwnSeats(req, res) {
    return ok(res, { seats: await admins.listOwnSeats(req.auth.userId) });
}

async function cancelApplication(req, res) {
    const seat = await admins.cancelApplication(req.auth.userId, req.validated.params.id);
    return ok(res, { seat, message: 'Application cancelled.' });
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

async function changeSubdomain(req, res) {
    const { params, body } = req.validated;
    const governingBody = await changeGoverningBodySubdomain(req.auth.userId, params.id, body);
    return ok(res, {
        governingBody,
        message: `${governingBody.name} is at "${governingBody.subdomain}" now. The old address no longer opens it.`,
    });
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

// A body left with no admin (ticket 04): its admins and applications, shaped by the
// service, and the Platform Admin's decision in the senior's place.
async function listBodyAdmins(req, res) {
    return ok(res, await admins.listAdminsOf(req.validated.params.id));
}

async function approveWithoutAdmin(req, res) {
    const { id, seatId } = req.validated.params;
    const application = await admins.decideWithoutAdmin(req.auth.userId, id, seatId, { action: 'APPROVE' });
    return ok(res, { application, message: 'Approved. They are its admin now, and its senior.' });
}

async function rejectWithoutAdmin(req, res) {
    const { id, seatId } = req.validated.params;
    const application = await admins.decideWithoutAdmin(req.auth.userId, id, seatId, {
        action: 'REJECT',
        reason: req.validated.body.reason,
    });
    return ok(res, { application, message: 'Rejected.' });
}

async function removeAsPlatformAdmin(req, res) {
    const { id, seatId } = req.validated.params;
    const seat = await admins.removeAsPlatformAdmin(req.auth.userId, id, seatId, req.validated.body);
    return ok(res, { seat, message: 'Removed. They no longer reach the governing body.' });
}

// ---- the seat ---------------------------------------------------------------

async function own(req, res) {
    return ok(res, { governingBody: await service.ownGoverningBody(req.auth) });
}

async function updateProfile(req, res) {
    const governingBody = await service.updateProfile(req.auth, req.validated.body);
    return ok(res, { governingBody, message: 'Saved.' });
}

async function rotateCode(req, res) {
    const governingBody = await service.rotateGoverningBodyCode(req.auth);
    return ok(res, { governingBody, message: 'A new Governing Body Code. The old one no longer works.' });
}

// The admins, the senior first, and the applications waiting: shaped by the service.
async function listAdmins(req, res) {
    return ok(res, await admins.listAdmins(req.auth));
}

async function approveApplication(req, res) {
    const application = await admins.approveApplication(req.auth, req.validated.params.id);
    return ok(res, { application, message: 'Approved. They are an admin now.' });
}

async function rejectApplication(req, res) {
    const application = await admins.rejectApplication(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { application, message: 'Rejected.' });
}

async function removeAdmin(req, res) {
    const seat = await admins.removeAdmin(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { seat, message: 'Removed. They no longer reach the governing body.' });
}

async function leave(req, res) {
    const seat = await admins.leaveGoverningBody(req.auth);
    return ok(res, { seat, message: 'You have left the governing body.' });
}

export {
    submit,
    listMine,
    lookup,
    applyAsAdmin,
    listOwnSeats,
    cancelApplication,
    list,
    get,
    ktp,
    proof,
    approve,
    reject,
    update,
    changeSubdomain,
    deactivate,
    reactivate,
    listBodyAdmins,
    approveWithoutAdmin,
    rejectWithoutAdmin,
    removeAsPlatformAdmin,
    own,
    updateProfile,
    rotateCode,
    listAdmins,
    approveApplication,
    rejectApplication,
    removeAdmin,
    leave,
};
