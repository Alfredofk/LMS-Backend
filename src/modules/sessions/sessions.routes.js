import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import * as controller from './sessions.controller.js';
import { scheduleBody, idParams, sessionsQuery, mineQuery } from './sessions.schema.js';

// Mounted at /api/sessions (teaching-and-learning tickets 02 and 09).
//
// The Principal or a Vice Principal sets a ClassSubject's weekly timetable; the
// school sets it, not each teacher (owner, 2026-09-27). Reading it, and the
// Sessions it makes, is for whoever the ClassSubject concerns - the service decides
// (the school's leaders, its teacher, the Class's homeroom teacher, its students),
// and answers 404 to anyone else.
//
// A Session created already past needs completion (ticket 09): its teacher finds it
// on the to-do list and answers that it never happened here, or that it did by
// confirming its attendance (POST /api/attendance/sessions/:id/confirm, t&l 03 -
// the old /:id/complete, which asked for no attendance, is gone). The school's
// leaders read the whole school's list.
//
// A student finds their Sessions through /mine - a day, or up to six weeks for a
// calendar - with their own attendance. Without it no Session id is in their reach
// to check in to.
//
// A teacher finds theirs through /teaching, over the same days: the Sessions they
// answer for, across all their ClassSubjects, each saying whether its attendance is
// confirmed (2026-10-03).

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

router.get('/mine', requireRole('STUDENT'), validate({ query: mineQuery }), controller.listMine);
router.get('/teaching', requireRole('TEACHER'), validate({ query: mineQuery }), controller.listTeaching);

router.get(
    '/needs-completion',
    requireRole('TEACHER', 'PRINCIPAL', 'VICE_PRINCIPAL'),
    controller.listNeedingCompletion
);
router.post('/:id/not-held', requireRole('TEACHER'), validate({ params: idParams }), controller.markNotHeld);

export default router;
