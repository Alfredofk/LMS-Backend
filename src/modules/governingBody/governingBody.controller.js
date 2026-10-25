import { ok } from '../../shared/errors.js';
import * as service from './governingBody.service.js';
import * as admins from './governingBody.admins.js';
import * as schools from './governingBody.schools.js';
import * as principals from './governingBody.principals.js';
import * as reads from './governingBody.reads.js';
import * as powers from './governingBody.powers.js';
import * as affiliations from './governingBody.affiliations.js';
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

// ---- applicant: Principal applications (ticket 06) --------------------------

async function applyAsPrincipal(req, res) {
    const application = await principals.submitApplication(req.auth.userId, req.validated.body, req.file);
    return ok(
        res,
        { application, message: 'Application sent. An admin of the school’s governing body will decide it.' },
        201
    );
}

async function listOwnPrincipalApplications(req, res) {
    return ok(res, { applications: await principals.listOwnApplications(req.auth.userId) });
}

async function cancelPrincipalApplication(req, res) {
    const application = await principals.cancelApplication(req.auth.userId, req.validated.params.id);
    return ok(res, { application, message: 'Application cancelled. Your KTP was discarded.' });
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

// ---- the seat: its Schools (ticket 05) --------------------------------------

async function createSchools(req, res) {
    const created = await schools.createSchools(req.auth, req.validated.body);
    return ok(
        res,
        { schools: created, message: 'Created. Each school is live, with its code, and waits for its Principal.' },
        201
    );
}

async function listSchools(req, res) {
    return ok(res, { schools: await schools.listOwnSchools(req.auth) });
}

async function fixSchool(req, res) {
    const school = await schools.fixSchool(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { school, message: 'Saved.' });
}

// ---- the seat: its reads (ticket 07) ------------------------------------------

async function getSchool(req, res) {
    return ok(res, { school: await schools.getOwnSchool(req.auth, req.validated.params.id) });
}

async function listSchoolTeachers(req, res) {
    return ok(res, await reads.listTeachers(req.auth, req.validated.params.id));
}

async function listSchoolStudents(req, res) {
    const { params, query } = req.validated;
    return ok(res, await reads.listStudents(req.auth, params.id, query));
}

// ---- the seat: its powers over its Schools (ticket 08) -------------------------

async function appointPrincipal(req, res) {
    const result = await powers.appointPrincipal(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, {
        ...result,
        message: `${result.principal.fullName} is the Principal of ${result.school.name} now.`,
    });
}

async function endPrincipal(req, res) {
    const result = await powers.endPrincipalRole(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, {
        ...result,
        message: 'The Principal’s role has ended. The school takes applications to be its Principal again.',
    });
}

async function deactivateSchool(req, res) {
    const school = await powers.deactivateSchool(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { school, message: 'Deactivated. Every member has lost access; nothing was deleted.' });
}

async function reactivateSchool(req, res) {
    const school = await powers.reactivateSchool(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { school, message: 'Reactivated. Members have to sign in again.' });
}

async function releaseSchool(req, res) {
    const result = await powers.releaseSchool(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { ...result, message: `${result.school.name} is independent now.` });
}

// ---- the seat: Affiliation Requests (ticket 08) ---------------------------------

async function listAffiliationRequests(req, res) {
    return ok(res, { requests: await affiliations.listBodyRequests(req.auth, req.validated.query) });
}

async function approveAffiliationRequest(req, res) {
    const request = await affiliations.approveRequest(req.auth, req.validated.params.id);
    return ok(res, { request, message: `${request.school.name} has joined the governing body.` });
}

async function rejectAffiliationRequest(req, res) {
    const request = await affiliations.rejectRequest(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { request, message: 'Rejected.' });
}

// ---- the seat: Principal applications (ticket 06) ---------------------------

async function listPrincipalApplications(req, res) {
    const { params, query } = req.validated;
    return ok(res, { applications: await principals.listForSchool(req.auth, params.id, query) });
}

async function getPrincipalApplication(req, res) {
    return ok(res, { application: await principals.getApplication(req.auth, req.validated.params.id) });
}

// File bytes, the one answer outside the envelope.
async function principalApplicationKtp(req, res) {
    const { buffer, contentType } = await principals.readKtp(req.auth, req.validated.params.id);
    res.set({ 'Content-Type': contentType, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return res.send(buffer);
}

async function approvePrincipalApplication(req, res) {
    const application = await principals.approveApplication(req.auth, req.validated.params.id);
    return ok(res, {
        application,
        message: 'Approved. They are the school’s Principal now; the others waiting were declined.',
    });
}

async function rejectPrincipalApplication(req, res) {
    const application = await principals.rejectApplication(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { application, message: 'Rejected. The KTP was discarded.' });
}

export {
    submit,
    listMine,
    lookup,
    applyAsAdmin,
    listOwnSeats,
    cancelApplication,
    applyAsPrincipal,
    listOwnPrincipalApplications,
    cancelPrincipalApplication,
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
    createSchools,
    listSchools,
    fixSchool,
    getSchool,
    listSchoolTeachers,
    listSchoolStudents,
    appointPrincipal,
    endPrincipal,
    deactivateSchool,
    reactivateSchool,
    releaseSchool,
    listAffiliationRequests,
    approveAffiliationRequest,
    rejectAffiliationRequest,
    listPrincipalApplications,
    getPrincipalApplication,
    principalApplicationKtp,
    approvePrincipalApplication,
    rejectPrincipalApplication,
};
