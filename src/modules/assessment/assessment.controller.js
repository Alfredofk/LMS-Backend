import { ok } from '../../shared/errors.js';
import * as bank from './assessment.bank.js';

// Thin, like the other controllers. The question bank (ticket 01) lives in
// assessment.bank.js; the Assessments themselves come with ticket 02.

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
};
