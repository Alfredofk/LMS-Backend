import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { requirePlatformAdmin } from '../../shared/guards.js';
import { validate } from '../../shared/validate.js';
import * as controller from './holidays.controller.js';
import {
    idParams,
    yearQuery,
    fetchBody,
    nationalBody,
    draftPatch,
    confirmBody,
    schoolHolidayBody,
    jointLeaveBody,
    jointLeaveDayBody,
} from './holidays.schema.js';

// Two routers (teaching-and-learning ticket 08), because two different people
// keep the calendar.
//
// The Platform Admin's, mounted at /api/admin/holidays: the national holidays and
// joint leave, which belong to no school. requirePlatformAdmin guards it all.
//
// The school's, mounted at /api/holidays: every ACTIVE member reads the calendar;
// the Principal or a Vice Principal adds or withdraws the school's own holidays
// and chooses whether joint leave is observed. requireRole is the coarse filter;
// the service re-reads the role from the database.

const adminRouter = Router();

adminRouter.use(requireAuth, requirePlatformAdmin);

adminRouter.get('/', validate({ query: yearQuery }), controller.listNational);
adminRouter.post('/fetch', validate({ body: fetchBody }), controller.fetchDrafts);
adminRouter.post('/confirm', validate({ body: confirmBody }), controller.confirmNational);
adminRouter.post('/', validate({ body: nationalBody }), controller.addNational);
adminRouter.patch('/:id', validate({ params: idParams, body: draftPatch }), controller.updateDraft);
adminRouter.post('/:id/withdraw', validate({ params: idParams }), controller.withdrawNational);

const router = Router();

// The school's calendar is the academic day-to-day: the Principal or a Vice
// Principal (registration-and-membership ticket 19).
const principalOrVice = requireRole('PRINCIPAL', 'VICE_PRINCIPAL');

router.use(requireAuth, requireActiveMembership);

router.get('/', validate({ query: yearQuery }), controller.calendar);
router.post('/school', principalOrVice, validate({ body: schoolHolidayBody }), controller.addSchoolHoliday);
router.post(
    '/school/:id/withdraw',
    principalOrVice,
    validate({ params: idParams }),
    controller.withdrawSchoolHoliday
);
router.patch('/joint-leave', principalOrVice, validate({ body: jointLeaveBody }), controller.setJointLeave);
// One joint-leave day, overriding the default above (owner, 2026-09-27). :id is a
// NationalHoliday's, as the calendar lists it.
router.put(
    '/joint-leave/:id',
    principalOrVice,
    validate({ params: idParams, body: jointLeaveDayBody }),
    controller.setJointLeaveDay
);

export default router;
export { adminRouter };
