import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRoleHidden } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import { singleFile } from '../../shared/upload.js';
import * as controller from './assessment.controller.js';
import { MAX_IMAGE_BYTES, IMAGE_TYPES } from './assessment.bank.js';
import {
    idParams,
    imageIdParams,
    questionImageParams,
    questionBody,
    questionEdit,
    questionListQuery,
    duplicateBody,
    assessmentBody,
    assessmentPatch,
    questionListBody,
    copyBody,
    cancelBody,
    assessmentImageParams,
} from './assessment.schema.js';

// Mounted at /api/assessments (assessment tickets 01 and 02).
//
// The question bank: teachers write questions per Subject x Grade Level, for what
// they teach now, and read the ones of what they teach now along with their own.
// Only a question's author edits, archives and restores it. The Principal and Vice
// Principals read the whole bank. Images are uploaded first, then named by id in the
// question.
//
// Assessments: the teacher who answers for a ClassSubject creates them on it, puts
// bank questions in, publishes, copies to their other Classes (or, with a new
// window, to another Semester's), cancels, and deletes a draft. The Class's
// homeroom teacher, the Principal and the Vice Principals read them, drafts
// included, and change nothing. Once its Semester is over, an Assessment is also
// read and copied by whoever teaches its Subject at its Grade Level now; a
// ClassSubject's copy-sources lists what its teacher may copy in (2026-10-07).
//
// staff is the coarse filter on every route, and it answers 404, not 403: a
// Student or a Guardian reaches none of these, the upload included. The services
// decide, from the database, which questions and Assessments the caller sees and
// may change. Students answer Assessments through routes of their own (ticket 03).

const router = Router();

const staff = requireRoleHidden('TEACHER', 'PRINCIPAL', 'VICE_PRINCIPAL');
const imageUpload = singleFile('image', { maxBytes: MAX_IMAGE_BYTES, types: IMAGE_TYPES });

router.use(requireAuth, requireActiveMembership);

// ---- images ----

// The upload sits after the role check, so a caller who is no staff is refused
// before the file is read.
router.post('/questions/images', staff, imageUpload, controller.uploadImage);
router.get('/questions/images/:imageId', staff, validate({ params: imageIdParams }), controller.readOwnImage);
router.get(
    '/questions/:id/images/:imageId',
    staff,
    validate({ params: questionImageParams }),
    controller.readQuestionImage
);

// ---- the question bank ----

router.get('/questions', staff, validate({ query: questionListQuery }), controller.listQuestions);
router.post('/questions', staff, validate({ body: questionBody }), controller.createQuestion);
router.get('/questions/:id', staff, validate({ params: idParams }), controller.getQuestion);
router.put('/questions/:id', staff, validate({ params: idParams, body: questionEdit }), controller.updateQuestion);
router.post(
    '/questions/:id/duplicate',
    staff,
    validate({ params: idParams, body: duplicateBody }),
    controller.duplicateQuestion
);
router.post('/questions/:id/archive', staff, validate({ params: idParams }), controller.archiveQuestion);
router.post('/questions/:id/restore', staff, validate({ params: idParams }), controller.restoreQuestion);

// ---- Assessments ----

// After the bank's routes, so /questions is never read as an Assessment's id.
router.get('/class-subjects/:id', staff, validate({ params: idParams }), controller.listForClassSubject);
router.post(
    '/class-subjects/:id',
    staff,
    validate({ params: idParams, body: assessmentBody }),
    controller.createAssessment
);
router.get(
    '/class-subjects/:id/copy-sources',
    staff,
    validate({ params: idParams }),
    controller.listCopySources
);
router.get('/:id', staff, validate({ params: idParams }), controller.getAssessment);
router.patch('/:id', staff, validate({ params: idParams, body: assessmentPatch }), controller.updateAssessment);
router.delete('/:id', staff, validate({ params: idParams }), controller.removeAssessment);
router.put(
    '/:id/questions',
    staff,
    validate({ params: idParams, body: questionListBody }),
    controller.replaceQuestions
);
router.post('/:id/publish', staff, validate({ params: idParams }), controller.publishAssessment);
router.post('/:id/copies', staff, validate({ params: idParams, body: copyBody }), controller.copyAssessment);
router.post('/:id/cancel', staff, validate({ params: idParams, body: cancelBody }), controller.cancelAssessment);
router.get(
    '/:id/images/:imageId',
    staff,
    validate({ params: assessmentImageParams }),
    controller.readAssessmentImage
);

export default router;
