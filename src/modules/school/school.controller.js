import { ok } from '../../shared/errors.js';
import * as service from './school.service.js';

/*
  Thin by design, like auth.controller.js: read what validation produced, call
  the service, wrap the answer in the envelope. No try/catch - Express 5 hands a
  rejected promise to the error handler in server.js on its own.
*/

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

async function list(req, res) {
    return ok(res, { registrations: await service.listRegistrations(req.validated.query) });
}

async function get(req, res) {
    return ok(res, { registration: await service.getRegistration(req.validated.params.id) });
}

/*
  The one response in the API that is not the JSON envelope: it is the image
  itself, for the admin's browser to show. no-store because it is a national ID
  document, and it must not linger in a cache after the file is deleted.
*/
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

export { submit, listMine, list, get, ktp, approve, reject };
