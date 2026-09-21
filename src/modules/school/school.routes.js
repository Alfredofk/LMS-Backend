import { Router } from 'express';

import { requireAuth } from '../../shared/auth.js';
import { requirePlatformAdmin } from '../../shared/guards.js';
import { registrationLimiter } from '../../shared/rateLimit.js';
import { singleFile } from '../../shared/upload.js';
import { validate } from '../../shared/validate.js';
import * as controller from './school.controller.js';
import {
    registrationBody,
    idParams,
    listQuery,
    rejectBody,
    deactivateBody,
    reactivateBody,
} from './school.schema.js';

/*
  Two routers, because two different people use them.

  The applicant's, mounted at /api/school-registrations. registrationLimiter
  keys on req.auth.userId, so it sits AFTER requireAuth - mounted before it, the
  key silently falls back to the IP (CLAUDE.md). It also sits before the upload,
  so a request over budget is refused without its 2 MB being read.

  The platform admin's, mounted at /api/admin/school-registrations. Every route
  on it is cross-tenant by definition, which is why requirePlatformAdmin guards
  the whole router rather than route by route.
*/

// KTP: JPG or PNG, at most 2 MB - the owner's rule (ticket 04).
const ktpUpload = singleFile('ktp', { maxBytes: 2 * 1024 * 1024, types: ['jpg', 'png'] });

const router = Router();

router.use(requireAuth);

router.post(
    '/',
    registrationLimiter,
    ktpUpload,
    validate({ body: registrationBody }),
    controller.submit
);
router.get('/mine', controller.listMine);

const adminRouter = Router();

adminRouter.use(requireAuth, requirePlatformAdmin);

adminRouter.get('/', validate({ query: listQuery }), controller.list);
adminRouter.get('/:id', validate({ params: idParams }), controller.get);
adminRouter.get('/:id/ktp', validate({ params: idParams }), controller.ktp);
adminRouter.post('/:id/approve', validate({ params: idParams }), controller.approve);
adminRouter.post(
    '/:id/reject',
    validate({ params: idParams, body: rejectBody }),
    controller.reject
);
/*
  Keyed on the registration, not the school, because that is the row the admin
  screen is holding - and because a school founded any other way has no
  registration to reach it through. If schools ever arrive by another route, this
  needs a sibling at /api/admin/schools/:id.
*/
adminRouter.post(
    '/:id/deactivate',
    validate({ params: idParams, body: deactivateBody }),
    controller.deactivate
);
adminRouter.post(
    '/:id/reactivate',
    validate({ params: idParams, body: reactivateBody }),
    controller.reactivate
);

export default router;
export { adminRouter };
