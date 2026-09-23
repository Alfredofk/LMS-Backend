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

export default router;
