import { Router } from 'express';

import { requireAuth } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import * as controller from './users.controller.js';
import { updateMeBody, changePasswordBody } from './users.schema.js';

/*
  requireAuth on the router rather than route by route, so a handler added later
  cannot be left open by omission.

  A token issued to someone with no active membership reaches all three of these
  and nothing else - requireAuth opens no school scope for it (auth.js:103), so
  any tenant-owned query it could trigger throws. That is ticket 03's "Done
  when", enforced by the extension rather than by a check anyone can forget.
*/
const router = Router();

router.use(requireAuth);

router.get('/me', controller.getMe);
router.patch('/me', validate({ body: updateMeBody }), controller.updateMe);
router.post(
    '/me/change-password',
    validate({ body: changePasswordBody }),
    controller.changePassword
);

export default router;
