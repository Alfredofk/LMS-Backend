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

async function updateAcademicYear(req, res) {
    const academicYear = await service.updateAcademicYear(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, { academicYear, message: 'Academic year updated.' });
}

async function deleteAcademicYear(req, res) {
    const academicYear = await service.deleteAcademicYear(req.auth, req.validated.params.id);
    return ok(res, { academicYear, message: 'Academic year deleted.' });
}

async function createSemester(req, res) {
    const academicYear = await service.createSemester(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, { academicYear }, 201);
}

// A semester is always answered with its whole year, as createSemester does.
async function updateSemester(req, res) {
    const academicYear = await service.updateSemester(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, { academicYear, message: 'Semester updated.' });
}

async function deleteSemester(req, res) {
    const academicYear = await service.deleteSemester(req.auth, req.validated.params.id);
    return ok(res, { academicYear, message: 'Semester deleted.' });
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

async function updateClass(req, res) {
    const target = await service.updateClass(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { class: target, message: 'Class updated.' });
}

async function deleteClass(req, res) {
    const target = await service.deleteClass(req.auth, req.validated.params.id);
    return ok(res, { class: target, message: 'Class deleted.' });
}

// ---- subjects -----------------------------------------------------------------

async function listSubjects(req, res) {
    return ok(res, { subjects: await service.listSubjects(req.auth) });
}

async function selectSubjects(req, res) {
    const subjects = await service.selectSubjects(req.auth, req.validated.body);
    return ok(res, { subjects, message: 'Subjects saved.' });
}

async function createSubject(req, res) {
    return ok(res, { subject: await service.createSubject(req.auth, req.validated.body) }, 201);
}

// ---- class subjects -----------------------------------------------------------

async function subjectBoard(req, res) {
    return ok(res, await service.subjectBoard(req.validated.params.id));
}

async function requestClassSubject(req, res) {
    const classSubject = await service.requestClassSubject(req.auth, req.validated.body);
    return ok(
        res,
        {
            classSubject,
            message:
                classSubject.status === 'ACTIVE'
                    ? 'You teach this subject in your own class now.'
                    : 'Request recorded. The Principal has to approve it.',
        },
        201
    );
}

async function listClassSubjects(req, res) {
    return ok(res, {
        classSubjects: await service.listClassSubjects(req.auth, req.validated.query),
    });
}

async function listOwnClassSubjects(req, res) {
    return ok(res, { classSubjects: await service.listOwnClassSubjects(req.auth) });
}

async function cancelClassSubject(req, res) {
    const classSubject = await service.cancelClassSubject(req.auth, req.validated.params.id);
    return ok(res, { classSubject, message: 'Request cancelled.' });
}

async function approveClassSubject(req, res) {
    const classSubject = await service.approveClassSubject(req.auth, req.validated.params.id);
    return ok(res, { classSubject, message: 'Approved.' });
}

async function rejectClassSubject(req, res) {
    const classSubject = await service.rejectClassSubject(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, { classSubject, message: 'Rejected.' });
}

async function endClassSubject(req, res) {
    const classSubject = await service.endClassSubject(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, {
        classSubject,
        message: req.validated.body.subjectStops
            ? 'Assignment ended. The subject stops and its coming sessions are cancelled.'
            : 'Assignment ended. Its coming sessions wait for the next teacher.',
    });
}

async function replaceClassSubject(req, res) {
    const result = await service.replaceClassSubject(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, { ...result, message: 'Teacher replaced.' });
}

// Always 200, like the membership bulk approve: an answer per request.
async function bulkApproveClassSubjects(req, res) {
    const results = await service.bulkApproveClassSubjects(req.auth, req.validated.body);
    const approved = results.filter((entry) => entry.ok).length;
    return ok(res, { results, summary: { approved, failed: results.length - approved } });
}

async function overrideClassSubject(req, res) {
    const classSubject = await service.overrideClassSubject(req.auth, req.validated.body);
    return ok(res, { classSubject, message: 'Assigned by the Principal.' }, 201);
}

// ---- class moves (ticket 16) --------------------------------------------------

async function listMoveTargets(req, res) {
    return ok(res, { classes: await service.listMoveTargets(req.auth, req.validated.params.id) });
}

async function requestClassMove(req, res) {
    const classMove = await service.requestClassMove(req.auth, req.validated.body);
    return ok(
        res,
        {
            classMove,
            message:
                classMove.status === 'ACTIVE'
                    ? 'Moved.'
                    : "Move requested. The other class's homeroom teacher has to accept it.",
        },
        201
    );
}

async function listClassMoves(req, res) {
    return ok(res, { classMoves: await service.listClassMoves(req.auth, req.validated.query) });
}

async function approveClassMove(req, res) {
    const classMove = await service.approveClassMove(req.auth, req.validated.params.id);
    return ok(res, { classMove, message: 'Accepted. The student is in your class now.' });
}

async function rejectClassMove(req, res) {
    const classMove = await service.rejectClassMove(
        req.auth,
        req.validated.params.id,
        req.validated.body
    );
    return ok(res, { classMove, message: 'Rejected.' });
}

async function cancelClassMove(req, res) {
    const classMove = await service.cancelClassMove(req.auth, req.validated.params.id);
    return ok(res, { classMove, message: 'Move cancelled.' });
}

export {
    listMoveTargets,
    requestClassMove,
    listClassMoves,
    approveClassMove,
    rejectClassMove,
    cancelClassMove,
    listSubjects,
    selectSubjects,
    createSubject,
    subjectBoard,
    requestClassSubject,
    listClassSubjects,
    listOwnClassSubjects,
    cancelClassSubject,
    approveClassSubject,
    rejectClassSubject,
    bulkApproveClassSubjects,
    endClassSubject,
    replaceClassSubject,
    overrideClassSubject,
    listTeachers,
    createAcademicYear,
    listAcademicYears,
    closeAcademicYear,
    updateAcademicYear,
    deleteAcademicYear,
    createSemester,
    updateSemester,
    deleteSemester,
    createClass,
    listClasses,
    getClass,
    changeHomeroom,
    updateClass,
    deleteClass,
};
