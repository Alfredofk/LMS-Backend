import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import * as controller from './dashboard.controller.js';
import { signalSettingsBody } from './dashboard.schema.js';

// Mounted at /api/dashboard (the dashboard spec, 2026-10-26): read-only views across the
// other modules (handoff #25, #31).
//
// - GET /teaching (ticket 01), for a member holding TEACHER - a Principal or a Vice
//   Principal who teaches included: their own slots of the current Semester, and their
//   marking queue. The service reads only the caller's own ClassSubjects, so there is no
//   resource to refuse; requireRole is the whole filter. Each slot carries its Students
//   needing support (ticket 02).
// - GET /signal-settings (ticket 02), for the School's staff: the Support Signal
//   thresholds, each with its source. PUT /signal-settings, for the Principal or a Vice
//   Principal (checked again in the service, ADR-0009), audited; null puts a value back
//   to the built-in one.
//
// No Student or Guardian reads anything here (the spec's invariant 1).

const router = Router();

const teacher = requireRole('TEACHER');
const staff = requireRole('PRINCIPAL', 'VICE_PRINCIPAL', 'TEACHER');
const principalOrVice = requireRole('PRINCIPAL', 'VICE_PRINCIPAL');

router.use(requireAuth, requireActiveMembership);

router.get('/teaching', teacher, controller.getTeaching);

router.get('/signal-settings', staff, controller.getSignalSettings);
router.put('/signal-settings', principalOrVice, validate({ body: signalSettingsBody }), controller.setSignalSettings);

export default router;
