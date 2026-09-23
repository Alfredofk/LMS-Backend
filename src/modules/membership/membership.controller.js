import { ok } from '../../shared/errors.js';
import * as service from './membership.service.js';

/*
  Thin by design, like school.controller.js: read what validation produced, call
  the service, wrap the answer in the envelope. No try/catch - Express 5 hands a
  rejected promise to the error handler in server.js on its own.
*/

// ---- applicant --------------------------------------------------------------

async function lookup(req, res) {
    return ok(res, { school: await service.lookupSchool(req.auth.userId, req.validated.body) });
}

async function request(req, res) {
    const membership = await service.requestJoin(req.auth.userId, req.validated.body);
    return ok(
        res,
        {
            membership,
            message: 'Request submitted. Someone at the school has to release it before you are in.',
        },
        201
    );
}

// ---- member -----------------------------------------------------------------

async function addRoles(req, res) {
    const membership = await service.addRoles(req.auth, req.validated.body);
    return ok(
        res,
        {
            membership,
            message:
                'Role request recorded. A role that is already active takes effect ' +
                'the next time your session refreshes.',
        },
        201
    );
}

// ---- reviewer ---------------------------------------------------------------

async function list(req, res) {
    return ok(res, { requests: await service.listRequests(req.auth, req.validated.query) });
}

async function get(req, res) {
    return ok(res, { request: await service.getRequest(req.auth, req.validated.params.id) });
}

async function approve(req, res) {
    const request_ = await service.approveRequest(req.auth, req.validated.params.id, {
        classId: req.validated.body.classId,
    });
    return ok(res, { request: request_, message: 'Released.' });
}

async function reject(req, res) {
    const request_ = await service.rejectRequest(req.auth, req.validated.params.id, {
        reason: req.validated.body.reason,
    });
    return ok(res, { request: request_, message: 'Rejected.' });
}

/*
  Always 200, even when some items failed: the caller asked about many requests
  and gets an answer per request. A single overall status code could only lie
  about one half of a mixed outcome.
*/
async function bulkApprove(req, res) {
    const results = await service.bulkApprove(req.auth, req.validated.body);
    const released = results.filter((entry) => entry.ok).length;

    return ok(res, {
        results,
        summary: { released, failed: results.length - released },
    });
}

export { lookup, request, addRoles, list, get, approve, reject, bulkApprove };
