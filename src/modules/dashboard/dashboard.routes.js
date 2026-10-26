import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import * as controller from './dashboard.controller.js';

// Mounted at /api/dashboard (the dashboard spec, 2026-10-26): read-only views across the
// other modules (handoff #25, #31).
//
// - GET /teaching (ticket 01), for a member holding TEACHER - a Principal or a Vice
//   Principal who teaches included: their own slots of the current Semester, and their
//   marking queue. The service reads only the caller's own ClassSubjects, so there is no
//   resource to refuse; requireRole is the whole filter.
//
// No Student or Guardian reads anything here (the spec's invariant 1).

const router = Router();

const teacher = requireRole('TEACHER');

router.use(requireAuth, requireActiveMembership);

router.get('/teaching', teacher, controller.getTeaching);

export default router;
