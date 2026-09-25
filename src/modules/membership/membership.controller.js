import { ok } from '../../shared/errors.js';
import * as service from './membership.service.js';

// Thin by design, like school.controller.js: read what validation produced, call
// the service, wrap the answer in the envelope. No try/catch - Express 5 hands a
// rejected promise to the error handler in server.js on its own.

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

async function cancelRequest(req, res) {
    const membership = await service.cancelJoinRequest(req.auth.userId);
    return ok(res, {
        membership,
        message: 'Join request cancelled. You are free to ask to join any school.',
    });
}

// ---- member -----------------------------------------------------------------

async function cancelRole(req, res) {
    const membership = await service.cancelRole(req.auth, req.validated.params.role);
    return ok(res, { membership, message: 'Role request cancelled.' });
}

async function linkChild(req, res) {
    const link = await service.linkChild(req.auth, req.validated.body);
    return ok(
        res,
        {
            link,
            message:
                link.status === 'ACTIVE'
                    ? 'Linked. The student has been told.'
                    : "Request recorded. The student's homeroom teacher has to release it.",
        },
        201
    );
}

async function cancelLink(req, res) {
    const link = await service.cancelLink(req.auth, req.validated.params.linkId);
    return ok(res, { link, message: 'Link request cancelled.' });
}

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

async function leave(req, res) {
    const membership = await service.leaveSchool(req.auth);
    return ok(res, {
        membership,
        message: 'You have left the school. You are free to ask to join any school.',
    });
}

// A letter is the one response here that is not the JSON envelope, like the KTP
// in school.controller.js: the file itself, inline for the browser to show, and
// no-store because it is a signed personal document.
function sendLetter(res, { buffer, contentType }) {
    res.set({
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
    });
    return res.send(buffer);
}

async function submitLeaveRequest(req, res) {
    const leaveRequest = await service.submitLeaveRequest(req.auth, req.validated.body, req.file);
    return ok(
        res,
        { leaveRequest, message: 'Leave request sent. The Principal has to approve it before you leave.' },
        201
    );
}

async function listOwnLeaveRequests(req, res) {
    return ok(res, { leaveRequests: await service.listOwnLeaveRequests(req.auth) });
}

async function cancelLeaveRequest(req, res) {
    const leaveRequest = await service.cancelLeaveRequest(req.auth);
    return ok(res, { leaveRequest, message: 'Leave request cancelled.' });
}

async function ownLeaveLetter(req, res) {
    return sendLetter(res, await service.readOwnLeaveLetter(req.auth, req.validated.params.id));
}

// ---- Principal: leave requests -----------------------------------------------

async function listLeaveRequests(req, res) {
    return ok(res, { leaveRequests: await service.listLeaveRequests(req.auth, req.validated.query) });
}

async function getLeaveRequest(req, res) {
    return ok(res, { leaveRequest: await service.getLeaveRequest(req.auth, req.validated.params.id) });
}

async function leaveLetter(req, res) {
    return sendLetter(res, await service.readLeaveLetter(req.auth, req.validated.params.id));
}

async function approveLeaveRequest(req, res) {
    const leaveRequest = await service.approveLeaveRequest(req.auth, req.validated.params.id);
    return ok(res, { leaveRequest, message: 'Approved. The member has left the school.' });
}

async function rejectLeaveRequest(req, res) {
    const leaveRequest = await service.rejectLeaveRequest(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, { leaveRequest, message: 'Rejected.' });
}

// ---- Principal: the school's people ------------------------------------------

async function listMembers(req, res) {
    return ok(res, { members: await service.listMembers(req.auth, req.validated.query) });
}

async function removeMember(req, res) {
    const membership = await service.removeMember(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, { membership, message: 'Removed from the school.' });
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

// Always 200, even when some items failed: the caller asked about many requests
// and gets an answer per request. A single overall status code could only lie
// about one half of a mixed outcome.
async function bulkApprove(req, res) {
    const results = await service.bulkApprove(req.auth, req.validated.body);
    const released = results.filter((entry) => entry.ok).length;

    return ok(res, {
        results,
        summary: { released, failed: results.length - released },
    });
}

export {
    lookup,
    request,
    cancelRequest,
    addRoles,
    cancelRole,
    linkChild,
    cancelLink,
    leave,
    submitLeaveRequest,
    listOwnLeaveRequests,
    cancelLeaveRequest,
    ownLeaveLetter,
    listLeaveRequests,
    getLeaveRequest,
    leaveLetter,
    approveLeaveRequest,
    rejectLeaveRequest,
    listMembers,
    removeMember,
    list,
    get,
    approve,
    reject,
    bulkApprove,
};
