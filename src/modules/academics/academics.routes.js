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
    academicYearPatch,
    semesterPatch,
    classPatch,
    idParams,
    classMoveBody,
    classMoveListQuery,
    subjectBody,
    classSubjectBody,
    overrideBody,
    classSubjectListQuery,
    rejectBody,
    bulkApproveBody,
    endBody,
    replaceBody,
} from './academics.schema.js';

// Mounted at /api/academics. Every caller holds an ACTIVE membership, and the
// token's school is the only school in reach - there is no school id in any path.
//
// requireRole is the coarse filter only: a STUDENT or GUARDIAN has no business
// here. The service re-reads PRINCIPAL (or VICE_PRINCIPAL) from the database for every write, and
// decides which classes a teacher may read, because homeroom teaching is a
// property of a class (Class.homeroomTeacherMembershipId), not a role.

const router = Router();

// The academic day-to-day: the Principal, or a Vice Principal (ticket 19).
const principalOrVice = requireRole('PRINCIPAL', 'VICE_PRINCIPAL');
// Named outright, not left to the TEACHER every Vice Principal happens to hold: a
// read the Vice Principal is granted (ticket 19) must not hang on another role.
const staff = requireRole('PRINCIPAL', 'VICE_PRINCIPAL', 'TEACHER');

router.use(requireAuth, requireActiveMembership);

router.get('/teachers', principalOrVice, controller.listTeachers);

router.post(
    '/academic-years',
    principalOrVice,
    validate({ body: academicYearBody }),
    controller.createAcademicYear
);
router.get('/academic-years', staff, controller.listAcademicYears);
router.post(
    '/academic-years/:id/close',
    principalOrVice,
    validate({ params: idParams }),
    controller.closeAcademicYear
);
router.post(
    '/academic-years/:id/semesters',
    principalOrVice,
    validate({ params: idParams, body: semesterBody }),
    controller.createSemester
);

// Corrections (owner, 2026-09-26). A delete takes only what is still empty, so
// nothing anybody did in it goes with it.
router.patch(
    '/academic-years/:id',
    principalOrVice,
    validate({ params: idParams, body: academicYearPatch }),
    controller.updateAcademicYear
);
router.delete(
    '/academic-years/:id',
    principalOrVice,
    validate({ params: idParams }),
    controller.deleteAcademicYear
);
router.patch(
    '/semesters/:id',
    principalOrVice,
    validate({ params: idParams, body: semesterPatch }),
    controller.updateSemester
);
router.delete('/semesters/:id', principalOrVice, validate({ params: idParams }), controller.deleteSemester);

router.post('/classes', principalOrVice, validate({ body: classBody }), controller.createClass);
router.get('/classes', staff, validate({ query: classListQuery }), controller.listClasses);
router.get('/classes/:id', staff, validate({ params: idParams }), controller.getClass);
router.patch(
    '/classes/:id/homeroom',
    principalOrVice,
    validate({ params: idParams, body: homeroomBody }),
    controller.changeHomeroom
);
router.patch(
    '/classes/:id',
    principalOrVice,
    validate({ params: idParams, body: classPatch }),
    controller.updateClass
);
router.delete('/classes/:id', principalOrVice, validate({ params: idParams }), controller.deleteClass);

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
router.post('/subjects', principalOrVice, validate({ body: subjectBody }), controller.createSubject);

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
    principalOrVice,
    validate({ body: bulkApproveBody }),
    controller.bulkApproveClassSubjects
);
router.post(
    '/class-subjects/override',
    principalOrVice,
    validate({ body: overrideBody }),
    controller.overrideClassSubject
);
router.post(
    '/class-subjects/:id/approve',
    principalOrVice,
    validate({ params: idParams }),
    controller.approveClassSubject
);
router.post(
    '/class-subjects/:id/reject',
    principalOrVice,
    validate({ params: idParams, body: rejectBody }),
    controller.rejectClassSubject
);
router.post(
    '/class-subjects/:id/cancel',
    teacher,
    validate({ params: idParams }),
    controller.cancelClassSubject
);
// An ACTIVE assignment ended or handed to another teacher while its teacher stays
// (teaching-and-learning 10).
router.post(
    '/class-subjects/:id/end',
    principalOrVice,
    validate({ params: idParams, body: endBody }),
    controller.endClassSubject
);
router.post(
    '/class-subjects/:id/replace',
    principalOrVice,
    validate({ params: idParams, body: replaceBody }),
    controller.replaceClassSubject
);

export default router;
