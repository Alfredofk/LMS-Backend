import { ok } from '../../shared/errors.js';
import * as service from './academics.service.js';

// Thin by design, like the other controllers: read what validation produced, call
// the service, wrap the answer in the envelope. No try/catch - Express 5 hands a
// rejected promise to the error handler in server.js on its own.

// ---- teachers ---------------------------------------------------------------

async function listTeachers(req, res) {
    return ok(res, { teachers: await service.listTeachers(req.auth) });
}

// ---- academic year and semester ---------------------------------------------

async function createAcademicYear(req, res) {
    const academicYear = await service.createAcademicYear(req.auth, req.validated.body);
    return ok(res, { academicYear }, 201);
}

async function listAcademicYears(_req, res) {
    return ok(res, { academicYears: await service.listAcademicYears() });
}

async function closeAcademicYear(req, res) {
    const academicYear = await service.closeAcademicYear(req.auth, req.validated.params.id);
    return ok(res, { academicYear, message: 'Academic year closed.' });
}

async function createSemester(req, res) {
    const academicYear = await service.createSemester(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, { academicYear }, 201);
}

// ---- class --------------------------------------------------------------------

async function createClass(req, res) {
    return ok(res, { class: await service.createClass(req.auth, req.validated.body) }, 201);
}

async function listClasses(req, res) {
    return ok(res, { classes: await service.listClasses(req.auth, req.validated.query) });
}

async function getClass(req, res) {
    return ok(res, { class: await service.getClass(req.auth, req.validated.params.id) });
}

async function changeHomeroom(req, res) {
    const target = await service.changeHomeroom(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, { class: target, message: 'Homeroom teacher changed.' });
}

export {
    listTeachers,
    createAcademicYear,
    listAcademicYears,
    closeAcademicYear,
    createSemester,
    createClass,
    listClasses,
    getClass,
    changeHomeroom,
};
