import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import * as controller from './attendance.controller.js';
import { idParams, checkInBody, confirmBody, attendancePatch, mineQuery } from './attendance.schema.js';

// Mounted at /api/attendance (teaching-and-learning ticket 03).
//
// A student checks in to a Session of their own Class; the teacher who answers for
// the Session confirms it, and corrects it after with a note. The school's
// leaders, that teacher and the Class's homeroom teacher read a Session's roster
// and a record's history. requireRole is the coarse filter; the service decides
// whose Session it is and answers 404 to anyone it does not concern.

const router = Router();

const student = requireRole('STUDENT');
const teacher = requireRole('TEACHER');
const staff = requireRole('PRINCIPAL', 'VICE_PRINCIPAL', 'TEACHER');

router.use(requireAuth, requireActiveMembership);

router.get('/me', student, validate({ query: mineQuery }), controller.mine);

router.post(
    '/sessions/:id/check-in',
    student,
    validate({ params: idParams, body: checkInBody }),
    controller.checkIn
);
router.post(
    '/sessions/:id/confirm',
    teacher,
    validate({ params: idParams, body: confirmBody }),
    controller.confirm
);
router.get('/sessions/:id', staff, validate({ params: idParams }), controller.getRoster);

router.patch('/:id', teacher, validate({ params: idParams, body: attendancePatch }), controller.correct);
router.get('/:id/history', staff, validate({ params: idParams }), controller.history);

export default router;
