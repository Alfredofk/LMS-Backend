import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRoleHidden } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import { singleFile } from '../../shared/upload.js';
import { MAX_FILE_BYTES, FILE_TYPES } from '../content/content.service.js';
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
    questionCopyEdit,
    questionParams,
    publishBody,
    copyBody,
    cancelBody,
    assessmentImageParams,
    answerBody,
    submissionParams,
    submissionAnswerParams,
    markBody,
    offlineMarksBody,
} from './assessment.schema.js';

// Mounted at /api/assessments (assessment tickets 01 to 04).
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
// A copy in an Assessment is edited in place by its teacher; with Submissions, the
// change voids them or marks them again (ticket 03).
//
// Every edit of a question or an Assessment, and publishing, sends back the updatedAt
// the caller last read; one changed since gets 409 (frontend note #12, 2026-10-09).
//
// Answering (ticket 03): a Student of the Class reads an Assessment's outline -
// never its questions - starts an attempt, saves answers one by one (an ESSAY's file
// too), and hands it in. The questions come inside the attempt, without their key.
// Once their attempt is released (ticket 04) they read its Score, its marks and the
// comments there, and the key if the teacher shows it.
//
// Marking (ticket 04): the teacher who answers for the ClassSubject marks ESSAY and
// SHORT answers, comments, enters an offline Assessment's marks, and releases, which
// records the Scores; after that a mark changes only with a reason, as a correction.
// The homeroom teacher, the Principal and the Vice Principals read the results and
// each Submission, and change nothing.
//
// staff is the coarse filter on the staff's routes, and student on the Student's;
// each answers 404, not 403, to everyone else - a Guardian reaches none of these,
// the uploads included. The services decide, from the database, which questions,
// Assessments and Submissions the caller sees and may change.

const router = Router();

const staff = requireRoleHidden('TEACHER', 'PRINCIPAL', 'VICE_PRINCIPAL');
const student = requireRoleHidden('STUDENT');
const imageUpload = singleFile('image', { maxBytes: MAX_IMAGE_BYTES, types: IMAGE_TYPES });
// An ESSAY's file follows Content's rules: PDF, JPG, PNG, DOCX or PPTX, 10 MB, no macros.
const essayUpload = singleFile('file', { maxBytes: MAX_FILE_BYTES, types: FILE_TYPES });

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

// ---- answering (ticket 03) ----

// Before the staff's /:id routes, so /submissions is never read as an Assessment's id.
router.get('/submissions/:id', student, validate({ params: idParams }), controller.getSubmission);
router.put(
    '/submissions/:id/answers/:questionId',
    student,
    validate({ params: questionParams, body: answerBody }),
    controller.saveAnswer
);
// The upload sits after the role check, as the bank's image upload does.
router.post(
    '/submissions/:id/answers/:questionId/file',
    student,
    validate({ params: questionParams }),
    essayUpload,
    controller.saveEssayFile
);
router.get(
    '/submissions/:id/answers/:questionId/file',
    student,
    validate({ params: questionParams }),
    controller.readEssayFile
);
router.get(
    '/submissions/:id/images/:imageId',
    student,
    validate({ params: assessmentImageParams }),
    controller.readSubmissionImage
);
router.post('/submissions/:id/submit', student, validate({ params: idParams }), controller.handIn);
router.get('/:id/mine', student, validate({ params: idParams }), controller.getOutline);
router.post('/:id/submissions', student, validate({ params: idParams }), controller.startSubmission);

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
router.put(
    '/:id/questions/:questionId',
    staff,
    validate({ params: questionParams, body: questionCopyEdit }),
    controller.editQuestion
);
router.post('/:id/publish', staff, validate({ params: idParams, body: publishBody }), controller.publishAssessment);
router.post('/:id/copies', staff, validate({ params: idParams, body: copyBody }), controller.copyAssessment);
router.post('/:id/cancel', staff, validate({ params: idParams, body: cancelBody }), controller.cancelAssessment);
router.get(
    '/:id/images/:imageId',
    staff,
    validate({ params: assessmentImageParams }),
    controller.readAssessmentImage
);

// ---- marking, release and Scores (ticket 04) ----

router.get('/:id/submissions', staff, validate({ params: idParams }), controller.listResults);
router.get('/:id/submissions/:submissionId', staff, validate({ params: submissionParams }), controller.getMarking);
router.get(
    '/:id/submissions/:submissionId/answers/:questionId/file',
    staff,
    validate({ params: submissionAnswerParams }),
    controller.readMarkingFile
);
router.put(
    '/:id/submissions/:submissionId/marks',
    staff,
    validate({ params: submissionParams, body: markBody }),
    controller.markSubmission
);
router.put(
    '/:id/offline-marks',
    staff,
    validate({ params: idParams, body: offlineMarksBody }),
    controller.enterOfflineMarks
);
router.post('/:id/release', staff, validate({ params: idParams }), controller.releaseAssessment);

export default router;
