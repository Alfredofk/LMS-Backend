import { ok } from '../../shared/errors.js';
import * as bank from './assessment.bank.js';
import * as service from './assessment.service.js';
import * as answering from './assessment.submission.js';

// Thin, like the other controllers. The question bank (ticket 01) lives in
// assessment.bank.js; the Assessments (ticket 02) in assessment.service.js; a
// Student's Submissions (ticket 03) in assessment.submission.js.

// ---- the question bank ----

async function listQuestions(req, res) {
    return ok(res, { questions: await bank.listQuestions(req.auth, req.validated.query) });
}

async function getQuestion(req, res) {
    return ok(res, { question: await bank.getQuestion(req.auth, req.validated.params.id) });
}

async function createQuestion(req, res) {
    return ok(res, { question: await bank.createQuestion(req.auth, req.validated.body) }, 201);
}

async function updateQuestion(req, res) {
    const question = await bank.updateQuestion(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { question, message: 'Question saved.' });
}

async function duplicateQuestion(req, res) {
    const question = await bank.duplicateQuestion(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { question }, 201);
}

async function archiveQuestion(req, res) {
    const question = await bank.archiveQuestion(req.auth, req.validated.params.id);
    return ok(res, { question, message: 'Question archived.' });
}

async function restoreQuestion(req, res) {
    const question = await bank.restoreQuestion(req.auth, req.validated.params.id);
    return ok(res, { question, message: 'Question restored.' });
}

// ---- images ----

async function uploadImage(req, res) {
    return ok(res, { image: await bank.uploadImage(req.auth, req.file) }, 201);
}

// The image itself, outside the envelope, as a Content file is. Always shown, never
// downloaded: it is a JPG or a PNG.
const sendImage = (res, { buffer, contentType }) => {
    res.set({ 'Content-Type': contentType, 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store' });
    return res.send(buffer);
};

async function readOwnImage(req, res) {
    return sendImage(res, await bank.readOwnImage(req.auth, req.validated.params.imageId));
}

async function readQuestionImage(req, res) {
    const { id, imageId } = req.validated.params;
    return sendImage(res, await bank.readQuestionImage(req.auth, id, imageId));
}

// ---- Assessments ----

async function listForClassSubject(req, res) {
    return ok(res, { assessments: await service.listForClassSubject(req.auth, req.validated.params.id) });
}

async function listCopySources(req, res) {
    return ok(res, { assessments: await service.listCopySources(req.auth, req.validated.params.id) });
}

async function createAssessment(req, res) {
    const assessment = await service.create(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { assessment }, 201);
}

async function getAssessment(req, res) {
    return ok(res, { assessment: await service.getAssessment(req.auth, req.validated.params.id) });
}

async function updateAssessment(req, res) {
    const assessment = await service.update(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { assessment, message: 'Assessment saved.' });
}

async function replaceQuestions(req, res) {
    const assessment = await service.replaceQuestions(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { assessment, message: 'Questions saved.' });
}

async function editQuestion(req, res) {
    const { id, questionId } = req.validated.params;
    const assessment = await service.editQuestion(req.auth, id, questionId, req.validated.body);
    return ok(res, { assessment, message: 'Question saved.' });
}

async function publishAssessment(req, res) {
    const assessment = await service.publish(req.auth, req.validated.params.id);
    return ok(res, { assessment, message: 'Assessment published.' });
}

async function copyAssessment(req, res) {
    return ok(res, { assessments: await service.copy(req.auth, req.validated.params.id, req.validated.body) }, 201);
}

async function cancelAssessment(req, res) {
    const assessment = await service.cancel(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { assessment, message: 'Assessment cancelled.' });
}

async function removeAssessment(req, res) {
    await service.remove(req.auth, req.validated.params.id);
    return ok(res, { message: 'Assessment deleted.' });
}

async function readAssessmentImage(req, res) {
    const { id, imageId } = req.validated.params;
    return sendImage(res, await service.readImage(req.auth, id, imageId));
}

// ---- answering (ticket 03) ----

// The outline, the questions with what was saved, and a hand-in each come back as
// the service shaped them.
async function getOutline(req, res) {
    return ok(res, await answering.outlineForStudent(req.auth, req.validated.params.id));
}

async function startSubmission(req, res) {
    return ok(res, await answering.start(req.auth, req.validated.params.id), 201);
}

async function getSubmission(req, res) {
    return ok(res, await answering.submissionForStudent(req.auth, req.validated.params.id));
}

async function saveAnswer(req, res) {
    const { id, questionId } = req.validated.params;
    return ok(res, { answer: await answering.saveAnswer(req.auth, id, questionId, req.validated.body) });
}

async function saveEssayFile(req, res) {
    const { id, questionId } = req.validated.params;
    return ok(res, { answer: await answering.saveEssayFile(req.auth, id, questionId, req.file) });
}

// The file itself, outside the envelope, as a Content file is: PDF and images open
// in the browser, DOCX and PPTX download under the name they were sent with.
async function readEssayFile(req, res) {
    const { id, questionId } = req.validated.params;
    const { buffer, contentType, fileName, inline } = await answering.readEssayFile(req.auth, id, questionId);
    res.set({
        'Content-Type': contentType,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'private, no-store',
    });
    return res.send(buffer);
}

async function readSubmissionImage(req, res) {
    const { id, imageId } = req.validated.params;
    return sendImage(res, await answering.readImage(req.auth, id, imageId));
}

async function handIn(req, res) {
    return ok(res, await answering.handIn(req.auth, req.validated.params.id));
}

export {
    listQuestions,
    getQuestion,
    createQuestion,
    updateQuestion,
    duplicateQuestion,
    archiveQuestion,
    restoreQuestion,
    uploadImage,
    readOwnImage,
    readQuestionImage,
    listForClassSubject,
    listCopySources,
    createAssessment,
    getAssessment,
    updateAssessment,
    replaceQuestions,
    editQuestion,
    publishAssessment,
    copyAssessment,
    cancelAssessment,
    removeAssessment,
    readAssessmentImage,
    getOutline,
    startSubmission,
    getSubmission,
    saveAnswer,
    saveEssayFile,
    readEssayFile,
    readSubmissionImage,
    handIn,
};
