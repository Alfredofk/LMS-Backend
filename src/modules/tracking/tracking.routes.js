import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import * as controller from './tracking.controller.js';
import { eventsBody } from './tracking.schema.js';

// Mounted at /api/tracking (teaching-and-learning ticket 05).
//
// A student's frontend reports what they did with a Content, in batches. Only a
// student sends: staff reading Content is not tracked. There is no other route,
// on purpose - nothing here reads, changes or removes a Learning Event. The reads
// built on them are ticket 06's.

const router = Router();

router.use(requireAuth, requireActiveMembership);

router.post('/events', requireRole('STUDENT'), validate({ body: eventsBody }), controller.recordEvents);

export default router;
