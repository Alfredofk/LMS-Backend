import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { joinSchoolLimiter } from '../../shared/rateLimit.js';
import { singleFile } from '../../shared/upload.js';
import { validate } from '../../shared/validate.js';
import * as controller from './membership.controller.js';
import {
    lookupBody,
    requestBody,
    addRolesBody,
    addChildBody,
    idParams,
    roleParams,
    linkParams,
    removeBody,
    leaveRequestBody,
    leaveListQuery,
    membersQuery,
    listQuery,
    approveBody,
    rejectBody,
    bulkApproveBody,
} from './membership.schema.js';

// Two routers here, because two different people use them - and, unlike ticket
// 04's pair, because they need opposite middleware. (A third and a fourth, for
// removing members and deciding leave requests, sit at the bottom of the file.)
//
// The applicant's, mounted at /api/memberships. Its callers hold NO membership
// (that is the point), so requireActiveMembership must never touch it.
// joinSchoolLimiter keys on req.auth.userId, so it sits AFTER requireAuth -
// mounted before it, the key silently falls back to the IP and a whole school
// shares one budget (CLAUDE.md). Lookup and request share the one limiter on
// purpose: they are two halves of the same act (shared/rateLimit.js).
//
// The reviewer's, mounted at /api/membership-requests. Its callers must hold an
// ACTIVE membership, and requireRole here is only a coarse pre-filter - a STUDENT
// or GUARDIAN has no business on this router at all. Which specific request a
// Principal or teacher may release is decided in the service, against
// Class.homeroomTeacherMembershipId, because a role string cannot say WHICH class.

// A resignation letter: PDF, JPG or PNG, at most 5 MB (owner, 2026-09-24).
const letterUpload = singleFile('letter', {
    maxBytes: 5 * 1024 * 1024,
    types: ['pdf', 'jpg', 'png'],
});

const router = Router();

router.use(requireAuth);

router.post('/lookup', joinSchoolLimiter, validate({ body: lookupBody }), controller.lookup);
router.post('/requests', joinSchoolLimiter, validate({ body: requestBody }), controller.request);
// Taking a PENDING join request back. No limiter beyond generalLimiter: it guesses
// nothing, and asking again is what /requests already rations.
router.post('/requests/cancel', controller.cancelRequest);
// The /me routes are the ones here whose caller DOES hold a membership, so each
// takes requireActiveMembership on its own rather than the router taking it.
// Adding a role shares joinSchoolLimiter because a GUARDIAN claim is the same
// NISN-and-name guess the join request makes, and must cost the same.
router.post(
    '/me/roles',
    requireActiveMembership,
    joinSchoolLimiter,
    validate({ body: addRolesBody }),
    controller.addRoles
);
router.post(
    '/me/roles/:role/cancel',
    requireActiveMembership,
    validate({ params: roleParams }),
    controller.cancelRole
);
// A further child is the same NISN-and-name guess as a GUARDIAN request, so it
// shares the same limiter.
router.post(
    '/me/children',
    requireActiveMembership,
    joinSchoolLimiter,
    validate({ body: addChildBody }),
    controller.linkChild
);
router.post(
    '/me/children/:linkId/cancel',
    requireActiveMembership,
    validate({ params: linkParams }),
    controller.cancelLink
);
// Leaving at once - only a member who needs nobody's approval, a guardian.
router.post('/me/leave', requireActiveMembership, controller.leave);
// A teacher or a student asks instead, with a resignation letter (ticket 17).
// The upload sits after requireActiveMembership, so a caller who is not a member
// is refused before the file is read.
router.post(
    '/me/leave-requests',
    requireActiveMembership,
    letterUpload,
    validate({ body: leaveRequestBody }),
    controller.submitLeaveRequest
);
router.get('/me/leave-requests', requireActiveMembership, controller.listOwnLeaveRequests);
router.post('/me/leave-requests/cancel', requireActiveMembership, controller.cancelLeaveRequest);
router.get(
    '/me/leave-requests/:id/letter',
    requireActiveMembership,
    validate({ params: idParams }),
    controller.ownLeaveLetter
);

const reviewRouter = Router();

reviewRouter.use(requireAuth, requireActiveMembership, requireRole('PRINCIPAL', 'TEACHER'));

reviewRouter.get('/', validate({ query: listQuery }), controller.list);
// Before /:id/approve only for the reader's sake; the two paths cannot collide.
reviewRouter.post('/approve', validate({ body: bulkApproveBody }), controller.bulkApprove);
reviewRouter.get('/:id', validate({ params: idParams }), controller.get);
reviewRouter.post(
    '/:id/approve',
    validate({ params: idParams, body: approveBody }),
    controller.approve
);
reviewRouter.post(
    '/:id/reject',
    validate({ params: idParams, body: rejectBody }),
    controller.reject
);

// A third router, mounted at /api/members: the school's people (ticket 06).
// Listing them and taking one out are the Principal's alone - since ticket 16 a
// homeroom teacher moves a student to another class instead of removing them.
const membersRouter = Router();

membersRouter.use(requireAuth, requireActiveMembership, requireRole('PRINCIPAL'));

membersRouter.get('/', validate({ query: membersQuery }), controller.listMembers);
membersRouter.post(
    '/:id/remove',
    validate({ params: idParams, body: removeBody }),
    controller.removeMember
);

// A fourth, mounted at /api/leave-requests: the Principal deciding who may leave
// (ticket 17). requireRole is the coarse filter; the service reads PRINCIPAL from
// the database again, as every Principal-only write does.
const leaveRequestRouter = Router();

leaveRequestRouter.use(requireAuth, requireActiveMembership, requireRole('PRINCIPAL'));

leaveRequestRouter.get('/', validate({ query: leaveListQuery }), controller.listLeaveRequests);
leaveRequestRouter.get('/:id', validate({ params: idParams }), controller.getLeaveRequest);
leaveRequestRouter.get('/:id/letter', validate({ params: idParams }), controller.leaveLetter);
leaveRequestRouter.post(
    '/:id/approve',
    validate({ params: idParams }),
    controller.approveLeaveRequest
);
leaveRequestRouter.post(
    '/:id/reject',
    validate({ params: idParams, body: rejectBody }),
    controller.rejectLeaveRequest
);

export default router;
export { reviewRouter, membersRouter, leaveRequestRouter };
