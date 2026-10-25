import { prisma } from '../../shared/prisma.js';
import { runInSchool, runUnscoped } from '../../shared/tenantContext.js';
import { recordAudit } from '../../shared/approval.js';
import { conflict } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import {
    SITTING_PRINCIPAL,
    appointPrincipal as appointAt,
    endPrincipal,
    lockSchool,
} from '../membership/membership.service.js';
import { restoreAccess, withdrawAccess } from '../school/school.service.js';
import { closeWaitingApplications, discardKtps } from './governingBody.principals.js';
import { getOwnSchool, loadOwnSchool } from './governingBody.schools.js';

const log = createLogger('GoverningBody');

// What a Governing Body changes in its running Schools (governing-body ticket 08, the
// spec's K10 and K12'), any admin of the body, each with a reason and audited.
//
// Owner's decisions (2026-10-18; the plan, 2026-10-26, through the picker):
// - The Principal is its business (K10), in the Platform Admin's place in ADR-0008. It
//   makes an ACTIVE Teacher the Principal, named by the membershipId the teacher list
//   gives (ticket 07), so no email is typed: anyone else is 404. The Principal before
//   follows ADR-0008, removed if they hold nothing else, and the applications waiting
//   there close, as an approval closes them (ticket 06). Audited HANDOVER.
// - Or it ends the role with no successor. The School wants a Principal again: its code
//   takes Principal Applications (ticket 06), and its data stays closed to the body's
//   fix, since it has had one (ticket 05). Audited END.
// - It deactivates and reactivates its School by the Platform Admin's own mechanism
//   (ticket 06b's cores). It does not undo a Platform Admin's deactivation, the brake
//   (owner's pick): 409.
// - It releases a School only while a Principal sits there (K12'): an independent School
//   without one could approve nobody. Its affiliation ends (the history table, owner's
//   pick against the proposal), audited RELEASE against the School. The Platform Admin is
//   its authority afterwards, through the School's own id (ticket 06b).
// - The Principal's own handover (ADR-0008) still works inside a body's School.

const SCHOOL_SUBJECT = 'School';
const BRAKE = 'The Platform Admin deactivated this school, so only the Platform Admin reactivates it';
const RELEASE_NEEDS_PRINCIPAL =
    'A school is released only while it has a Principal: an independent school without one could approve nobody';

// POST /api/governing-body/schools/:id/principal, for any admin: a Teacher of the School
// made its Principal. The School's row comes back, with the Principal and the ones before.
async function appointPrincipal(auth, schoolId, { membershipId, reason }) {
    const school = await loadOwnSchool(auth, schoolId);

    let closedKeys = [];
    const result = await runInSchool(school.id, school.name, () =>
        appointAt({
            schoolId: school.id,
            membershipId,
            reason,
            adminUserId: auth.userId,
            alongside: async (tx, now) => {
                closedKeys = await closeWaitingApplications(tx, { schoolId: school.id, actorUserId: auth.userId, now });
            },
        })
    );

    await discardKtps(closedKeys);
    log.info(
        `A governing body appointed the Principal of ${school.name}; ` +
            `${closedKeys.length} application(s) waiting there closed`
    );
    return { school: await getOwnSchool(auth, school.id), ...result };
}

// POST /api/governing-body/schools/:id/principal/end, for any admin.
async function endPrincipalRole(auth, schoolId, { reason }) {
    const school = await loadOwnSchool(auth, schoolId);

    const result = await runInSchool(school.id, school.name, () =>
        endPrincipal({ schoolId: school.id, reason: reason.trim(), actorUserId: auth.userId })
    );

    log.info(`A governing body ended the Principal's role at ${school.name}`);
    return { school: await getOwnSchool(auth, school.id), ...result };
}

// POST /api/governing-body/schools/:id/deactivate, for any admin: its members' sign-ins
// there cut, its code and subdomain unknown, nothing deleted (ticket 06b's withdrawAccess).
async function deactivateSchool(auth, schoolId, { reason }) {
    const school = await loadOwnSchool(auth, schoolId);
    await runUnscoped('a governing body withdrawing its school access', () =>
        withdrawAccess(school, { adminUserId: auth.userId, reason })
    );
    return getOwnSchool(auth, school.id);
}

// POST /api/governing-body/schools/:id/reactivate, for any admin, the note optional. Only
// what the body switched off: deactivatedByAdminId is set by a Platform Admin alone, a
// taken-over deactivation included. Read first for the answer, and claimed again by
// restoreAccess, so a take-over at the same moment wins.
async function reactivateSchool(auth, schoolId, { reason } = {}) {
    const school = await loadOwnSchool(auth, schoolId);
    const { deactivatedByAdminId } = await prisma.school.findUnique({
        where: { id: school.id },
        select: { deactivatedByAdminId: true },
    });
    if (deactivatedByAdminId) throw conflict(BRAKE);

    await runUnscoped('a governing body restoring its school access', () =>
        restoreAccess(school, { adminUserId: auth.userId, reason, onlyTheBodys: true })
    );
    return getOwnSchool(auth, school.id);
}

// POST /api/governing-body/schools/:id/release, for any admin. Under the School's lock: a
// Principal sitting (409 otherwise), the claim that it is still this body's, its
// affiliation ended, the audit. The body reads it no more, so only its name comes back.
async function releaseSchool(auth, schoolId, { reason }) {
    const school = await loadOwnSchool(auth, schoolId);
    const trimmed = reason.trim();
    const now = new Date();

    await runInSchool(school.id, school.name, async () =>
        await prisma.$transaction(async (tx) => {
            await lockSchool(tx, school.id, now);
            if (!(await tx.membershipRole.findFirst({ where: SITTING_PRINCIPAL, select: { id: true } }))) {
                throw conflict(RELEASE_NEEDS_PRINCIPAL);
            }

            const claimed = await tx.school.updateMany({
                where: { id: school.id, governingBodyId: auth.governingBodyId },
                data: { governingBodyId: null },
            });
            if (claimed.count === 0) throw conflict('This school has left this governing body meanwhile');

            await tx.schoolAffiliation.updateMany({
                where: { schoolId: school.id, governingBodyId: auth.governingBodyId, endedAt: null },
                data: { endedAt: now, endedByUserId: auth.userId, endReason: trimmed },
            });
            await recordAudit({
                schoolId: school.id,
                subjectType: SCHOOL_SUBJECT,
                subjectId: school.id,
                action: 'RELEASE',
                actorUserId: auth.userId,
                reason: trimmed,
                client: tx,
            });
        })
    );

    log.info(`${school.name} released by its governing body, independent now`);
    return { school: { id: school.id, name: school.name } };
}

export { appointPrincipal, endPrincipalRole, deactivateSchool, reactivateSchool, releaseSchool };
