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
} from './assessment.schema.js';

// Mounted at /api/assessments (assessment ticket 01: the question bank).
//
// Teachers write questions per Subject x Grade Level, for what they teach now, and
// read the ones of what they teach now along with their own. Only a question's
// author edits, archives and restores it. The Principal and Vice Principals read
// the whole bank. Images are uploaded first, then named by id in the question.
//
// staff is the coarse filter on every route, and it answers 404, not 403: a
// Student or a Guardian reaches none of the bank, the upload included. The service
// decides which questions the caller sees and may change, from the database.

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

export default router;
