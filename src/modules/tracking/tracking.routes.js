import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import * as controller from './tracking.controller.js';
import { eventsBody, idParams } from './tracking.schema.js';

// Mounted at /api/tracking (teaching-and-learning tickets 05 and 06).
//
// A student's frontend reports what they did with a Content, in batches. Only a
// student sends: staff reading Content is not tracked. Nothing here reads, changes
// or removes a Learning Event - on purpose.
//
// The progress views (ticket 06) read what the events derived instead, Content
// Progress and Attendance (handoff #24):
// - a ClassSubject's, per student and per Content, for the teacher who answers for
//   it, the Principal and Vice Principals, and the Class's homeroom teacher;
// - a student's own, per ClassSubject of their Class.
// requireRole is the coarse filter; the service decides whose ClassSubject it is
// and answers 404 to anyone it does not concern.

const router = Router();

const student = requireRole('STUDENT');
const staff = requireRole('PRINCIPAL', 'VICE_PRINCIPAL', 'TEACHER');

router.use(requireAuth, requireActiveMembership);

router.post('/events', student, validate({ body: eventsBody }), controller.recordEvents);

router.get('/me/progress', student, controller.getOwnProgress);
router.get(
    '/class-subjects/:id/progress',
    staff,
    validate({ params: idParams }),
    controller.getClassSubjectProgress
);

export default router;
