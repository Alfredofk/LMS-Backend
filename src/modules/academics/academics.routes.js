import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import * as controller from './academics.controller.js';
import {
    academicYearBody,
    semesterBody,
    classBody,
    homeroomBody,
    classListQuery,
    idParams,
    classMoveBody,
    classMoveListQuery,
    subjectBody,
    classSubjectBody,
    overrideBody,
    classSubjectListQuery,
    rejectBody,
    bulkApproveBody,
} from './academics.schema.js';

// Mounted at /api/academics. Every caller holds an ACTIVE membership, and the
// token's school is the only school in reach - there is no school id in any path.
//
// requireRole is the coarse filter only: a STUDENT or GUARDIAN has no business
// here. The service re-reads PRINCIPAL from the database for every write, and
// decides which classes a teacher may read, because homeroom teaching is a
// property of a class (Class.homeroomTeacherMembershipId), not a role.

const router = Router();

const principal = requireRole('PRINCIPAL');
const staff = requireRole('PRINCIPAL', 'TEACHER');

router.use(requireAuth, requireActiveMembership);

router.get('/teachers', principal, controller.listTeachers);

router.post(
    '/academic-years',
    principal,
    validate({ body: academicYearBody }),
    controller.createAcademicYear
);
router.get('/academic-years', staff, controller.listAcademicYears);
router.post(
    '/academic-years/:id/close',
    principal,
    validate({ params: idParams }),
    controller.closeAcademicYear
);
router.post(
    '/academic-years/:id/semesters',
    principal,
    validate({ params: idParams, body: semesterBody }),
    controller.createSemester
);

router.post('/classes', principal, validate({ body: classBody }), controller.createClass);
router.get('/classes', staff, validate({ query: classListQuery }), controller.listClasses);
router.get('/classes/:id', staff, validate({ params: idParams }), controller.getClass);
router.patch(
    '/classes/:id/homeroom',
    principal,
    validate({ params: idParams, body: homeroomBody }),
    controller.changeHomeroom
);

// ---- ticket 16: moving a student to another class ---------------------------
//
// staff is the coarse filter only. Who may ask, decide or cancel is the homeroom
// teacher of the class on that side of the move, read in the service.

router.get(
    '/classes/:id/move-targets',
    staff,
    validate({ params: idParams }),
    controller.listMoveTargets
);
router.get('/class-moves', staff, validate({ query: classMoveListQuery }), controller.listClassMoves);
router.post('/class-moves', staff, validate({ body: classMoveBody }), controller.requestClassMove);
router.post(
    '/class-moves/:id/approve',
    staff,
    validate({ params: idParams }),
    controller.approveClassMove
);
router.post(
    '/class-moves/:id/reject',
    staff,
    validate({ params: idParams, body: rejectBody }),
    controller.rejectClassMove
);
router.post(
    '/class-moves/:id/cancel',
    staff,
    validate({ params: idParams }),
    controller.cancelClassMove
);

// ---- ticket 08: subjects and teaching assignments ---------------------------

const teacher = requireRole('TEACHER');

router.get('/subjects', staff, controller.listSubjects);
router.post('/subjects', principal, validate({ body: subjectBody }), controller.createSubject);

router.get(
    '/semesters/:id/class-subjects',
    staff,
    validate({ params: idParams }),
    controller.subjectBoard
);

router.get(
    '/class-subjects',
    staff,
    validate({ query: classSubjectListQuery }),
    controller.listClassSubjects
);
router.post(
    '/class-subjects',
    teacher,
    validate({ body: classSubjectBody }),
    controller.requestClassSubject
);
router.post(
    '/class-subjects/approve',
    principal,
    validate({ body: bulkApproveBody }),
    controller.bulkApproveClassSubjects
);
router.post(
    '/class-subjects/override',
    principal,
    validate({ body: overrideBody }),
    controller.overrideClassSubject
);
router.post(
    '/class-subjects/:id/approve',
    principal,
    validate({ params: idParams }),
    controller.approveClassSubject
);
router.post(
    '/class-subjects/:id/reject',
    principal,
    validate({ params: idParams, body: rejectBody }),
    controller.rejectClassSubject
);
router.post(
    '/class-subjects/:id/cancel',
    teacher,
    validate({ params: idParams }),
    controller.cancelClassSubject
);

export default router;
