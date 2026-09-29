import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import * as controller from './sessions.controller.js';
import { scheduleBody, idParams, sessionsQuery } from './sessions.schema.js';

// Mounted at /api/sessions (teaching-and-learning tickets 02 and 09).
//
// The Principal or a Vice Principal sets a ClassSubject's weekly timetable; the
// school sets it, not each teacher (owner, 2026-09-27). Reading it, and the
// Sessions it makes, is for whoever the ClassSubject concerns - the service decides
// (the school's leaders, its teacher, the Class's homeroom teacher, its students),
// and answers 404 to anyone else.
//
// A Session created already past needs completion (ticket 09): its teacher finds it
// on the to-do list and answers that it happened or that it never did. The school's
// leaders read the whole school's list.

const router = Router();

router.use(requireAuth, requireActiveMembership);

router.put(
    '/class-subjects/:id/schedule',
    requireRole('PRINCIPAL', 'VICE_PRINCIPAL'),
    validate({ params: idParams, body: scheduleBody }),
    controller.setSchedule
);
router.get('/class-subjects/:id/schedule', validate({ params: idParams }), controller.getSchedule);
router.get(
    '/class-subjects/:id/sessions',
    validate({ params: idParams, query: sessionsQuery }),
    controller.listSessions
);

router.get(
    '/needs-completion',
    requireRole('TEACHER', 'PRINCIPAL', 'VICE_PRINCIPAL'),
    controller.listNeedingCompletion
);
router.post(
    '/:id/complete',
    requireRole('TEACHER'),
    validate({ params: idParams }),
    controller.completeSession
);
router.post('/:id/not-held', requireRole('TEACHER'), validate({ params: idParams }), controller.markNotHeld);

export default router;
