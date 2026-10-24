import { Router } from 'express';

import { requireAuth } from '../../shared/auth.js';
import { requireGoverningBodyAdmin, requirePlatformAdmin } from '../../shared/guards.js';
import { governingBodyRegistrationLimiter, joinSchoolLimiter } from '../../shared/rateLimit.js';
import { fileFields } from '../../shared/upload.js';
import { validate } from '../../shared/validate.js';
import * as controller from './governingBody.controller.js';
import {
    registrationBody,
    idParams,
    codeBody,
    removeBody,
    profileBody,
    listQuery,
    decisionBody,
    editBody,
} from './governingBody.schema.js';
import { subdomainBody } from '../school/school.schema.js';

// Governing Bodies (governing-body tickets 03 and 04). Five routers, for three people.
//
// The applicant's, mounted at /api/governing-body-registrations: any signed-in
// account; the service refuses a Student and a second one waiting.
// governingBodyRegistrationLimiter keys on req.auth.userId, so it sits AFTER
// requireAuth, and before the upload, so a request over budget is refused before its
// files are read.
//
// The code's, mounted at /api/governing-body-applications (ticket 04): any signed-in
// account looks the Governing Body Code up and applies to be an admin through it; the
// service refuses an unverified account and a Student. The lookup and the application
// share joinSchoolLimiter with the School Code's: one budget for guessing any code,
// keyed on req.auth.userId, so it sits after requireAuth.
//
// The Platform Admin's, mounted at /api/admin/governing-body-registrations (the queue
// and its decisions) and /api/admin/governing-bodies (a body: its correction, its
// deactivation), keyed by the body as a School's subdomain change is (owner,
// 2026-10-22). requirePlatformAdmin guards each whole router.
//
// The seat's, mounted at /api/governing-body: the body the token's seat is for,
// requireGoverningBodyAdmin reading the seat on every request. Every admin reads the
// admins, rotates the code, changes the address and phone, and leaves unless the last;
// the service lets only the senior admin approve, reject and remove (403 for the rest).

// The KTP: JPG or PNG, at most 2 MB, as a School Registration's. The proof of office -
// the akta page or the surat tugas - PDF, JPG or PNG, at most 5 MB (owner, 2026-10-22).
const registrationFiles = fileFields({
    ktp: { maxBytes: 2 * 1024 * 1024, types: ['jpg', 'png'] },
    proof: { maxBytes: 5 * 1024 * 1024, types: ['pdf', 'jpg', 'png'] },
});

const router = Router();

router.use(requireAuth);

router.post(
    '/',
    governingBodyRegistrationLimiter,
    registrationFiles,
    validate({ body: registrationBody }),
    controller.submit
);
router.get('/mine', controller.listMine);

const adminRegistrationRouter = Router();

adminRegistrationRouter.use(requireAuth, requirePlatformAdmin);

adminRegistrationRouter.get('/', validate({ query: listQuery }), controller.list);
adminRegistrationRouter.get('/:id', validate({ params: idParams }), controller.get);
adminRegistrationRouter.get('/:id/ktp', validate({ params: idParams }), controller.ktp);
adminRegistrationRouter.get('/:id/proof', validate({ params: idParams }), controller.proof);
adminRegistrationRouter.post('/:id/approve', validate({ params: idParams }), controller.approve);
adminRegistrationRouter.post(
    '/:id/reject',
    validate({ params: idParams, body: decisionBody }),
    controller.reject
);

const adminBodyRouter = Router();

adminBodyRouter.use(requireAuth, requirePlatformAdmin);

adminBodyRouter.patch('/:id', validate({ params: idParams, body: editBody }), controller.update);
// Its subdomain, as a School's is changed (ticket 04, owner 2026-10-24): the same
// label rules, one space across both tables.
adminBodyRouter.patch(
    '/:id/subdomain',
    validate({ params: idParams, body: subdomainBody }),
    controller.changeSubdomain
);
adminBodyRouter.post(
    '/:id/deactivate',
    validate({ params: idParams, body: decisionBody }),
    controller.deactivate
);
adminBodyRouter.post(
    '/:id/reactivate',
    validate({ params: idParams, body: decisionBody }),
    controller.reactivate
);

const applicationRouter = Router();

applicationRouter.use(requireAuth);

applicationRouter.post('/lookup', joinSchoolLimiter, validate({ body: codeBody }), controller.lookup);
applicationRouter.post('/admins', joinSchoolLimiter, validate({ body: codeBody }), controller.applyAsAdmin);
applicationRouter.post('/admins/:id/cancel', validate({ params: idParams }), controller.cancelApplication);
applicationRouter.get('/mine', controller.listOwnSeats);

const seatRouter = Router();

seatRouter.use(requireAuth, requireGoverningBodyAdmin);

seatRouter.get('/', controller.own);
seatRouter.patch('/', validate({ body: profileBody }), controller.updateProfile);
seatRouter.post('/code/rotate', controller.rotateCode);
seatRouter.get('/admins', controller.listAdmins);
seatRouter.post('/admins/:id/approve', validate({ params: idParams }), controller.approveApplication);
seatRouter.post(
    '/admins/:id/reject',
    validate({ params: idParams, body: decisionBody }),
    controller.rejectApplication
);
seatRouter.post(
    '/admins/:id/remove',
    validate({ params: idParams, body: removeBody }),
    controller.removeAdmin
);
seatRouter.post('/leave', controller.leave);

export default router;
export { adminRegistrationRouter, adminBodyRouter, applicationRouter, seatRouter };
