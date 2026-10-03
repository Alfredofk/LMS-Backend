import { ok } from '../../shared/errors.js';
import * as service from './content.service.js';

// Thin, like the other controllers.

async function listForSession(req, res) {
    return ok(res, await service.listForSession(req.auth, req.validated.params.id));
}

async function create(req, res) {
    const content = await service.create(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { content }, 201);
}

async function createFile(req, res) {
    const content = await service.createFile(req.auth, req.validated.params.id, req.validated.body, req.file);
    return ok(res, { content }, 201);
}

async function update(req, res) {
    return ok(res, { content: await service.update(req.auth, req.validated.params.id, req.validated.body) });
}

async function publish(req, res) {
    return ok(res, { content: await service.publish(req.auth, req.validated.params.id) });
}

async function reorder(req, res) {
    return ok(res, await service.reorder(req.auth, req.validated.params.id, req.validated.body));
}

async function remove(req, res) {
    await service.remove(req.auth, req.validated.params.id);
    return ok(res, { message: 'Content deleted.' });
}

// The one response here that is not the JSON envelope, like a leave letter: the
// file itself. PDF and images open in the browser; DOCX and PPTX download, under
// the name they were uploaded with.
async function readFile(req, res) {
    const { buffer, contentType, fileName, inline } = await service.readFile(req.auth, req.validated.params.id);
    res.set({
        'Content-Type': contentType,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'private, no-store',
    });
    return res.send(buffer);
}

export { listForSession, create, createFile, update, publish, reorder, remove, readFile };
