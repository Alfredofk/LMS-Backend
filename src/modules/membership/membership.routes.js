import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { joinSchoolLimiter } from '../../shared/rateLimit.js';
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
    listQuery,
    approveBody,
    rejectBody,
    bulkApproveBody,
} from './membership.schema.js';

// Two routers, because two different people use them - and, unlike ticket 04's
// pair, because they need opposite middleware.
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

export default router;
export { reviewRouter };
