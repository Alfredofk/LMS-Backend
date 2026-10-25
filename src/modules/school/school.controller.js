import { ok } from '../../shared/errors.js';
import * as affiliations from '../governingBody/governingBody.affiliations.js';
import * as principals from '../governingBody/governingBody.principals.js';
import * as service from './school.service.js';
import * as letterheads from './school.letterhead.js';
import * as subdomains from './school.subdomain.js';

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

async function updateLocation(req, res) {
    const school = await service.updateSchoolLocation(req.auth, req.validated.body);
    return ok(res, { school, message: 'School location updated.' });
}

async function updateTimeZone(req, res) {
    const school = await service.updateSchoolTimeZone(req.auth, req.validated.body);
    return ok(res, { school, message: 'School time zone updated.' });
}

// ---- the letterhead (grading-and-report-card 10) ----

async function updateLetterhead(req, res) {
    const letterhead = await letterheads.updateLetterhead(req.auth, req.validated.body);
    return ok(res, { letterhead, message: 'Letterhead updated.' });
}

async function setLogo(req, res) {
    const letterhead = await letterheads.setLogo(req.auth, req.file);
    return ok(res, { letterhead, message: 'Logo saved.' });
}

async function removeLogo(req, res) {
    const letterhead = await letterheads.removeLogo(req.auth);
    return ok(res, { letterhead, message: 'Logo removed.' });
}

async function readLogo(req, res) {
    const { buffer, contentType, fileName } = await letterheads.readLogo(req.auth);
    res.set({
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'private, no-store',
    });
    return res.send(buffer);
}

async function appointPrincipal(req, res) {
    const result = await service.appointPrincipal(req.validated.params.id, {
        ...reviewer(req),
        ...req.validated.body,
    });
    return ok(res, {
        ...result,
        message: `${result.principal.fullName} is the Principal of ${result.school.name} now.`,
    });
}

// ---- subdomains (governing-body ticket 02) ----------------------------------

// Public: the page a subdomain opens asks whose it is.
async function resolvePlace(req, res) {
    return ok(res, { place: await subdomains.resolvePlace(req.validated.params.subdomain) });
}

async function changeSubdomain(req, res) {
    const school = await subdomains.changeSubdomain(req.auth.userId, req.validated.params.id, req.validated.body);
    return ok(res, {
        school,
        message: `${school.name} is at "${school.subdomain}" now. The old address no longer opens it.`,
    });
}

// ---- platform admin: every School (governing-body ticket 05) ---------------

// The page, the filtered total and the paging, shaped by the service.
async function listSchools(req, res) {
    return ok(res, await service.listSchools(req.validated.query));
}

// ---- platform admin: a School by its own id (governing-body ticket 06b) -------

async function deactivateById(req, res) {
    const school = await service.deactivateSchoolById(req.validated.params.id, {
        ...reviewer(req),
        reason: req.validated.body.reason,
    });
    return ok(res, { school, message: 'Deactivated. Every member has lost access; nothing was deleted.' });
}

async function reactivateById(req, res) {
    const school = await service.reactivateSchoolById(req.validated.params.id, {
        ...reviewer(req),
        reason: req.validated.body.reason,
    });
    return ok(res, { school, message: 'Reactivated. Members have to sign in again.' });
}

async function appointPrincipalById(req, res) {
    const result = await service.appointPrincipalById(req.validated.params.id, {
        ...reviewer(req),
        ...req.validated.body,
    });
    return ok(res, {
        ...result,
        message: `${result.principal.fullName} is the Principal of ${result.school.name} now.`,
    });
}

// ---- platform admin: Principal Applications while the body is deactivated (06c) ----

async function listPrincipalApplications(req, res) {
    const { params, query } = req.validated;
    return ok(res, { applications: await principals.listAsPlatformAdmin(params.id, query) });
}

// File bytes, the one answer outside the envelope.
async function principalApplicationKtp(req, res) {
    const { id, applicationId } = req.validated.params;
    const { buffer, contentType } = await principals.readKtpAsPlatformAdmin(id, applicationId);
    res.set({ 'Content-Type': contentType, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return res.send(buffer);
}

async function approvePrincipalApplication(req, res) {
    const { id, applicationId } = req.validated.params;
    const application = await principals.approveAsPlatformAdmin(req.auth.userId, id, applicationId);
    return ok(res, {
        application,
        message: 'Approved. They are the school’s Principal now; the others waiting were declined.',
    });
}

async function rejectPrincipalApplication(req, res) {
    const { id, applicationId } = req.validated.params;
    const application = await principals.rejectAsPlatformAdmin(req.auth.userId, id, applicationId, req.validated.body);
    return ok(res, { application, message: 'Rejected. The KTP was discarded.' });
}

// ---- Principal: asking to join a Governing Body (governing-body ticket 08) -------

async function requestAffiliation(req, res) {
    const request = await affiliations.requestAffiliation(req.auth, req.validated.body);
    return ok(
        res,
        { request, message: `Request sent. An admin of ${request.governingBody.name} will decide it.` },
        201
    );
}

async function listAffiliationRequests(req, res) {
    return ok(res, { requests: await affiliations.listSchoolRequests(req.auth) });
}

async function cancelAffiliationRequest(req, res) {
    const request = await affiliations.cancelRequest(req.auth, req.validated.params.id);
    return ok(res, { request, message: 'Request cancelled.' });
}

// ---- platform admin: the bodies a School has been under (ticket 08) ---------------

async function listAffiliations(req, res) {
    return ok(res, { affiliations: await affiliations.affiliationsOf(req.validated.params.id) });
}

export {
    resolvePlace,
    changeSubdomain,
    listSchools,
    deactivateById,
    reactivateById,
    appointPrincipalById,
    listPrincipalApplications,
    principalApplicationKtp,
    approvePrincipalApplication,
    rejectPrincipalApplication,
    requestAffiliation,
    listAffiliationRequests,
    cancelAffiliationRequest,
    listAffiliations,
    submit,
    listMine,
    list,
    get,
    ktp,
    approve,
    reject,
    deactivate,
    reactivate,
    appointPrincipal,
    rotateCode,
    updateLocation,
    updateTimeZone,
    updateLetterhead,
    setLogo,
    removeLogo,
    readLogo,
};
