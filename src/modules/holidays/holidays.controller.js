import { ok } from '../../shared/errors.js';
import * as service from './holidays.service.js';

// Thin, like the other controllers.

const reviewer = (req) => ({ adminId: req.platformAdminId, adminUserId: req.auth.userId });

// ---- the Platform Admin's national calendar -----------------------------------

async function listNational(req, res) {
    return ok(res, { holidays: await service.listNational(req.validated.query.year) });
}

async function fetchDrafts(req, res) {
    const result = await service.fetchDrafts(req.validated.body.year);
    return ok(res, {
        ...result,
        message: 'Drafts only. Check them against the SKB 3 Menteri, then confirm.',
    });
}

async function addNational(req, res) {
    const holiday = await service.addNational(req.validated.body, reviewer(req));
    return ok(res, { holiday }, 201);
}

async function updateDraft(req, res) {
    const holiday = await service.updateDraft(req.validated.params.id, req.validated.body);
    return ok(res, { holiday });
}

async function confirmNational(req, res) {
    return ok(res, await service.confirmNational(req.validated.body.ids, reviewer(req)));
}

async function withdrawNational(req, res) {
    const holiday = await service.withdrawNational(req.validated.params.id, reviewer(req));
    return ok(res, { holiday, message: 'Withdrawn.' });
}

// ---- a school's calendar --------------------------------------------------------

async function calendar(req, res) {
    return ok(res, await service.calendar(req.auth, req.validated.query.year));
}

async function addSchoolHoliday(req, res) {
    const holiday = await service.addSchoolHoliday(req.auth, req.validated.body);
    return ok(res, { holiday }, 201);
}

async function withdrawSchoolHoliday(req, res) {
    const holiday = await service.withdrawSchoolHoliday(req.auth, req.validated.params.id);
    return ok(res, { holiday, message: 'Withdrawn.' });
}

async function setJointLeave(req, res) {
    return ok(res, await service.setJointLeave(req.auth, req.validated.body));
}

async function setJointLeaveDay(req, res) {
    const day = await service.setJointLeaveDay(req.auth, req.validated.params.id, req.validated.body);
    return ok(res, { day });
}

export {
    listNational,
    fetchDrafts,
    addNational,
    updateDraft,
    confirmNational,
    withdrawNational,
    calendar,
    addSchoolHoliday,
    withdrawSchoolHoliday,
    setJointLeave,
    setJointLeaveDay,
};
