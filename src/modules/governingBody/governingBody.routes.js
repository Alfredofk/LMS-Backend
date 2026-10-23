import { Router } from 'express';

import { requireAuth } from '../../shared/auth.js';
import { requireGoverningBodyAdmin, requirePlatformAdmin } from '../../shared/guards.js';
import { governingBodyRegistrationLimiter } from '../../shared/rateLimit.js';
import { fileFields } from '../../shared/upload.js';
import { validate } from '../../shared/validate.js';
import * as controller from './governingBody.controller.js';
import { registrationBody, idParams, listQuery, decisionBody, editBody } from './governingBody.schema.js';

// Governing Bodies (governing-body ticket 03). Four routers, for three people.
//
// The applicant's, mounted at /api/governing-body-registrations: any signed-in
// account; the service refuses a Student and a second one waiting.
// governingBodyRegistrationLimiter keys on req.auth.userId, so it sits AFTER
// requireAuth, and before the upload, so a request over budget is refused before its
// files are read.
//
// The Platform Admin's, mounted at /api/admin/governing-body-registrations (the queue
// and its decisions) and /api/admin/governing-bodies (a body: its correction, its
// deactivation), keyed by the body as a School's subdomain change is (owner,
// 2026-10-22). requirePlatformAdmin guards each whole router.
//
// The seat's, mounted at /api/governing-body: the body the token's seat is for,
// requireGoverningBodyAdmin reading the seat on every request.

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

const seatRouter = Router();

seatRouter.use(requireAuth, requireGoverningBodyAdmin);

seatRouter.get('/', controller.own);

export default router;
export { adminRegistrationRouter, adminBodyRouter, seatRouter };
