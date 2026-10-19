import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole, requireRoleHidden } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import * as controller from './grading.controller.js';
import {
    idParams,
    schoolSettingsBody,
    slotSettingsBody,
    slotClearBody,
    noteParams,
    descriptionsBody,
    notesBody,
    closeBody,
    reopenBody,
} from './grading.schema.js';

// Mounted at /api/grading (grading-and-report-card tickets 01 to 06).
//
// Grade settings: the school's default Grade Weights and KKTP, and its Remedial Rule,
// read by its staff and set by the Principal or a Vice Principal; a slot's own
// weights and KKTP, named by any ClassSubject of the slot, read by its staff and set
// or cleared by its Answering Teacher. Every write sends back the updatedAt it read.
// A slot's running grades (ticket 02) are read by its staff, never by a Student; they
// carry its Descriptions (ticket 03), which its Answering Teacher writes. A Class's
// Notes for a Semester are read by its Homeroom Teacher, the Principal and the Vice
// Principals, and written by the Homeroom Teacher. requireRole is the coarse filter;
// the service checks the role against the database and decides whose slot or Class it
// is, answering 404 to anyone it does not concern. A Student reaches none of the slot
// or Class routes (404), as with the assessment staff's.
//
// Finalising (ticket 04): the Principal starts a Semester's finalising and stops it
// while no slot is finalised - a Vice Principal is told no in the service; a slot's
// Answering Teacher finalises it and undoes that; the Principal and the Vice
// Principals read the readiness board, and a Teacher is told no (403).
//
// Closing (ticket 05): the Principal closes a Semester, which writes its Report Cards -
// a Vice Principal is told no in the service. A Student reads their own Report Cards;
// one Report Card is read by its Student, the Homeroom Teacher of its Class, the
// Principal and the Vice Principals, and a Class's by the last three; the service
// answers 404 to anyone else. A Guardian reaches none of them.
//
// Reopening (ticket 06): the Principal takes a closed Semester back to finalising, with
// a reason - a Vice Principal is told no in the service. The staff's reads of a Report
// Card name every version they may open; a Student reads only the newest.

const router = Router();

const staff = requireRole('PRINCIPAL', 'VICE_PRINCIPAL', 'TEACHER');
const principalOrVice = requireRole('PRINCIPAL', 'VICE_PRINCIPAL');
const slotStaff = requireRoleHidden('PRINCIPAL', 'VICE_PRINCIPAL', 'TEACHER');
const student = requireRole('STUDENT');
const reader = requireRole('PRINCIPAL', 'VICE_PRINCIPAL', 'TEACHER', 'STUDENT');

router.use(requireAuth, requireActiveMembership);

// ---- the school's ----

router.get('/settings', staff, controller.getSchoolSettings);
router.put('/settings', principalOrVice, validate({ body: schoolSettingsBody }), controller.setSchoolSettings);

// ---- a slot's ----

router.get('/class-subjects/:id/settings', slotStaff, validate({ params: idParams }), controller.getSlotSettings);
router.put(
    '/class-subjects/:id/settings',
    slotStaff,
    validate({ params: idParams, body: slotSettingsBody }),
    controller.setSlotSettings
);
router.delete(
    '/class-subjects/:id/settings',
    slotStaff,
    validate({ params: idParams, body: slotClearBody }),
    controller.clearSlotSettings
);

// ---- a slot's grades ----

router.get('/class-subjects/:id/grades', slotStaff, validate({ params: idParams }), controller.getSlotGrades);

// ---- a slot's descriptions, a Class's notes ----

router.put(
    '/class-subjects/:id/descriptions',
    slotStaff,
    validate({ params: idParams, body: descriptionsBody }),
    controller.writeDescriptions
);
router.get(
    '/classes/:id/semesters/:semesterId/notes',
    slotStaff,
    validate({ params: noteParams }),
    controller.getNotes
);
router.put(
    '/classes/:id/semesters/:semesterId/notes',
    slotStaff,
    validate({ params: noteParams, body: notesBody }),
    controller.writeNotes
);

// ---- finalising ----

router.post(
    '/semesters/:id/start-finalising',
    principalOrVice,
    validate({ params: idParams }),
    controller.startFinalising
);
router.post(
    '/semesters/:id/stop-finalising',
    principalOrVice,
    validate({ params: idParams }),
    controller.stopFinalising
);
router.get('/semesters/:id/readiness', principalOrVice, validate({ params: idParams }), controller.getReadiness);
router.post('/class-subjects/:id/finalise', slotStaff, validate({ params: idParams }), controller.finalise);
router.post('/class-subjects/:id/unfinalise', slotStaff, validate({ params: idParams }), controller.unfinalise);

// ---- closing, Report Cards ----

router.post(
    '/semesters/:id/close',
    principalOrVice,
    validate({ params: idParams, body: closeBody }),
    controller.closeSemester
);
router.post(
    '/semesters/:id/reopen',
    principalOrVice,
    validate({ params: idParams, body: reopenBody }),
    controller.reopenSemester
);
router.get('/report-cards/mine', student, controller.getMyReportCards);
router.get('/report-cards/:id', reader, validate({ params: idParams }), controller.getReportCard);
router.get(
    '/classes/:id/semesters/:semesterId/report-cards',
    slotStaff,
    validate({ params: noteParams }),
    controller.getClassReportCards
);

export default router;
