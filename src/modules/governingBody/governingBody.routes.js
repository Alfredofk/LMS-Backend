import { Router } from 'express';

import { requireAuth } from '../../shared/auth.js';
import { requireGoverningBodyAdmin, requirePlatformAdmin } from '../../shared/guards.js';
import { governingBodyRegistrationLimiter, joinSchoolLimiter } from '../../shared/rateLimit.js';
import { fileFields, singleFile } from '../../shared/upload.js';
import { validate } from '../../shared/validate.js';
import * as controller from './governingBody.controller.js';
import {
    registrationBody,
    idParams,
    seatParams,
    codeBody,
    principalApplicationBody,
    principalApplicationsQuery,
    studentsQuery,
    reasonBody,
    appointBody,
    removeBody,
    profileBody,
    listQuery,
    decisionBody,
    editBody,
    createSchoolsBody,
    schoolPatchBody,
} from './governingBody.schema.js';
import { subdomainBody } from '../school/school.schema.js';

// Governing Bodies (governing-body tickets 03 and 04). Five routers, for three people.
//
// The applicant's, mounted at /api/governing-body-registrations: any signed-in
// account; the service refuses a Student and a second one waiting.
// governingBodyRegistrationLimiter keys on req.auth.userId, so it sits AFTER
// requireAuth, and before the upload, so a request over budget is refused before its
// files are read.
//
// The code's, mounted at /api/governing-body-applications (ticket 04): any signed-in
// account looks the Governing Body Code up and applies to be an admin through it; the
// service refuses an unverified account and a Student. The lookup and the application
// share joinSchoolLimiter with the School Code's: one budget for guessing any code,
// keyed on req.auth.userId, so it sits after requireAuth.
//
// The Platform Admin's, mounted at /api/admin/governing-body-registrations (the queue
// and its decisions) and /api/admin/governing-bodies (a body: its correction, its
// subdomain, its deactivation, and since ticket 04 the admin applications of a body
// left with none), keyed by the body as a School's subdomain change is (owner,
// 2026-10-22). requirePlatformAdmin guards each whole router.
//
// The seat's, mounted at /api/governing-body: the body the token's seat is for,
// requireGoverningBodyAdmin reading the seat on every request. Every admin reads the
// admins, rotates the code, changes the address and phone, and leaves unless the last;
// the service lets only the senior admin approve, reject and remove (403 for the rest).
// Since ticket 05 every admin also creates, reads and fixes the body's Schools; the
// service answers another body's School with 404, and a fix of one that has ever had a
// Principal with 409. Since ticket 06 every admin, not only the senior, reads and
// decides the Principal applications to the body's Schools, their own included; the
// service answers another body's application with 404. Since ticket 07 every admin reads
// the dashboard on the Schools' rows (the list and one School), and a School's Teachers
// and Students; another body's School is 404, and an account with no seat 403 here, at
// the guard, before any School is looked at (owner, 2026-10-26). Since ticket 08 every
// admin also makes a Teacher of its School the Principal or ends the role, deactivates and
// reactivates it (never undoing the Platform Admin's deactivation: 409), releases it while
// a Principal sits (409 otherwise), and decides the Affiliation Requests of independent
// Schools asking to join; each with a reason where the service says so.
//
// The Principal applicant's, mounted at /api/principal-applications (ticket 06): any
// signed-in account applies through a School's own code, with a KTP; the service refuses
// an unverified account, a School that takes no application, a member of it and a
// Student. The submission shares joinSchoolLimiter, after requireAuth and before the
// upload: guessing a School Code costs the same here as at the lookup.

// The KTP: JPG or PNG, at most 2 MB, as a School Registration's. The proof of office -
// the akta page or the surat tugas - PDF, JPG or PNG, at most 5 MB (owner, 2026-10-22).
const registrationFiles = fileFields({
    ktp: { maxBytes: 2 * 1024 * 1024, types: ['jpg', 'png'] },
    proof: { maxBytes: 5 * 1024 * 1024, types: ['pdf', 'jpg', 'png'] },
});

// A Principal applicant's KTP, as a School Registration's (ticket 06).
const ktpUpload = singleFile('ktp', { maxBytes: 2 * 1024 * 1024, types: ['jpg', 'png'] });

const router = Router();

router.use(requireAuth);

router.post(
    '/',
    governingBodyRegistrationLimiter,
    registrationFiles,
    validate({ body: registrationBody }),
    controller.submit
);
router.get('/mine', controller.listMine);

const adminRegistrationRouter = Router();

adminRegistrationRouter.use(requireAuth, requirePlatformAdmin);

adminRegistrationRouter.get('/', validate({ query: listQuery }), controller.list);
adminRegistrationRouter.get('/:id', validate({ params: idParams }), controller.get);
adminRegistrationRouter.get('/:id/ktp', validate({ params: idParams }), controller.ktp);
adminRegistrationRouter.get('/:id/proof', validate({ params: idParams }), controller.proof);
adminRegistrationRouter.post('/:id/approve', validate({ params: idParams }), controller.approve);
adminRegistrationRouter.post(
    '/:id/reject',
    validate({ params: idParams, body: decisionBody }),
    controller.reject
);

const adminBodyRouter = Router();

adminBodyRouter.use(requireAuth, requirePlatformAdmin);

adminBodyRouter.patch('/:id', validate({ params: idParams, body: editBody }), controller.update);
// Its subdomain, as a School's is changed (ticket 04, owner 2026-10-24): the same
// label rules, one space across both tables.
adminBodyRouter.patch(
    '/:id/subdomain',
    validate({ params: idParams, body: subdomainBody }),
    controller.changeSubdomain
);
adminBodyRouter.post(
    '/:id/deactivate',
    validate({ params: idParams, body: decisionBody }),
    controller.deactivate
);
adminBodyRouter.post(
    '/:id/reactivate',
    validate({ params: idParams, body: decisionBody }),
    controller.reactivate
);
// A body left with no admin (ticket 04, owner 2026-10-24): its admins and applications,
// with its code to hand on, and the Platform Admin's decision in the senior's place -
// refused (409) once anyone sits.
adminBodyRouter.get('/:id/admins', validate({ params: idParams }), controller.listBodyAdmins);
adminBodyRouter.post(
    '/:id/admins/:seatId/approve',
    validate({ params: seatParams }),
    controller.approveWithoutAdmin
);
adminBodyRouter.post(
    '/:id/admins/:seatId/reject',
    validate({ params: seatParams, body: decisionBody }),
    controller.rejectWithoutAdmin
);
// The brake on a stalled body (owner, 2026-10-24): any sitting admin removed with a
// reason, its senior or its last included.
adminBodyRouter.post(
    '/:id/admins/:seatId/remove',
    validate({ params: seatParams, body: removeBody }),
    controller.removeAsPlatformAdmin
);

const applicationRouter = Router();

applicationRouter.use(requireAuth);

applicationRouter.post('/lookup', joinSchoolLimiter, validate({ body: codeBody }), controller.lookup);
applicationRouter.post('/admins', joinSchoolLimiter, validate({ body: codeBody }), controller.applyAsAdmin);
applicationRouter.post('/admins/:id/cancel', validate({ params: idParams }), controller.cancelApplication);
applicationRouter.get('/mine', controller.listOwnSeats);

const principalApplicationRouter = Router();

principalApplicationRouter.use(requireAuth);

principalApplicationRouter.post(
    '/',
    joinSchoolLimiter,
    ktpUpload,
    validate({ body: principalApplicationBody }),
    controller.applyAsPrincipal
);
principalApplicationRouter.get('/mine', controller.listOwnPrincipalApplications);
principalApplicationRouter.post(
    '/:id/cancel',
    validate({ params: idParams }),
    controller.cancelPrincipalApplication
);

const seatRouter = Router();

seatRouter.use(requireAuth, requireGoverningBodyAdmin);

seatRouter.get('/', controller.own);
seatRouter.patch('/', validate({ body: profileBody }), controller.updateProfile);
seatRouter.post('/code/rotate', controller.rotateCode);
seatRouter.get('/admins', controller.listAdmins);
seatRouter.post('/admins/:id/approve', validate({ params: idParams }), controller.approveApplication);
seatRouter.post(
    '/admins/:id/reject',
    validate({ params: idParams, body: decisionBody }),
    controller.rejectApplication
);
seatRouter.post(
    '/admins/:id/remove',
    validate({ params: idParams, body: removeBody }),
    controller.removeAdmin
);
seatRouter.post('/leave', controller.leave);
seatRouter.get('/schools', controller.listSchools);
seatRouter.post('/schools', validate({ body: createSchoolsBody }), controller.createSchools);
seatRouter.get('/schools/:id', validate({ params: idParams }), controller.getSchool);
seatRouter.patch('/schools/:id', validate({ params: idParams, body: schoolPatchBody }), controller.fixSchool);
seatRouter.get('/schools/:id/teachers', validate({ params: idParams }), controller.listSchoolTeachers);
seatRouter.get(
    '/schools/:id/students',
    validate({ params: idParams, query: studentsQuery }),
    controller.listSchoolStudents
);
seatRouter.post(
    '/schools/:id/principal',
    validate({ params: idParams, body: appointBody }),
    controller.appointPrincipal
);
seatRouter.post(
    '/schools/:id/principal/end',
    validate({ params: idParams, body: reasonBody }),
    controller.endPrincipal
);
seatRouter.post(
    '/schools/:id/deactivate',
    validate({ params: idParams, body: reasonBody }),
    controller.deactivateSchool
);
seatRouter.post(
    '/schools/:id/reactivate',
    validate({ params: idParams, body: decisionBody }),
    controller.reactivateSchool
);
seatRouter.post('/schools/:id/release', validate({ params: idParams, body: reasonBody }), controller.releaseSchool);
seatRouter.get(
    '/affiliation-requests',
    validate({ query: principalApplicationsQuery }),
    controller.listAffiliationRequests
);
seatRouter.post(
    '/affiliation-requests/:id/approve',
    validate({ params: idParams }),
    controller.approveAffiliationRequest
);
seatRouter.post(
    '/affiliation-requests/:id/reject',
    validate({ params: idParams, body: decisionBody }),
    controller.rejectAffiliationRequest
);
seatRouter.get(
    '/schools/:id/principal-applications',
    validate({ params: idParams, query: principalApplicationsQuery }),
    controller.listPrincipalApplications
);
seatRouter.get('/principal-applications/:id', validate({ params: idParams }), controller.getPrincipalApplication);
seatRouter.get(
    '/principal-applications/:id/ktp',
    validate({ params: idParams }),
    controller.principalApplicationKtp
);
seatRouter.post(
    '/principal-applications/:id/approve',
    validate({ params: idParams }),
    controller.approvePrincipalApplication
);
seatRouter.post(
    '/principal-applications/:id/reject',
    validate({ params: idParams, body: decisionBody }),
    controller.rejectPrincipalApplication
);

export default router;
export { adminRegistrationRouter, adminBodyRouter, applicationRouter, principalApplicationRouter, seatRouter };
