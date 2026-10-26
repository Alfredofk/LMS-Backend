import { prisma } from '../../shared/prisma.js';
import { runInSchool, runUnscoped } from '../../shared/tenantContext.js';
import { recordAudit } from '../../shared/approval.js';
import { SCHOOL_TYPES, isValidDurationYears } from '../../shared/schoolType.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import { NPSN_TAKEN, createSchool, npsnsTakenOf } from '../school/school.service.js';
import { SITTING_PRINCIPAL } from '../membership/membership.service.js';

const log = createLogger('GoverningBody');

// The Schools a Governing Body creates (governing-body ticket 05, the spec's K7, K10 and
// K6c), beside the body's own rules in governingBody.service.js.
//
// Owner's decisions (2026-10-18; the plan, 2026-10-24, through the picker):
// - Any admin of a live body creates up to 10 Schools in one submission, all or none.
//   They are live at once, with no Platform Admin queue, no KTP and no Principal. Every
//   failing row is named in one answer.
// - A row is a School Registration's fields and rules, without the phone. An NPSN a
//   School holds or an independent registration waits on refuses its row with the
//   vague answer, an NPSN of another body's School included.
// - Each School gets its School Code and its K9 subdomain, both read in the
//   submission's one transaction, and is audited CREATE.
// - The admins read the School Code: since K8's change the body hands it to the person
//   it wants as Principal (ticket 06).
// - Any admin fixes a School's name, NPSN, type and an SMK's duration while it has
//   never had a Principal; with one now or before, 409 (owner, 2026-10-25: ticket 08
//   ends a Principal's role, and a School left so keeps its Classes and grades, which a
//   change of type would strand). The subdomain does not follow. Audited UPDATE_SCHOOL
//   with what it was.
// - A School of another body answers 404, as a missing one does. Whether a School has
//   a Principal is read in its own scope, one School at a time (the spec's invariant 1).
// - Each School says hasPrincipal, one sitting now, and hadPrincipal, one now or before
//   (owner, 2026-10-25, from the frontend's note). The fix asks the second, so a School
//   whose Principal's role ended shows no fix button rather than answering it with 409.
// - Ticket 07 (the spec's K4; the plan, owner 2026-10-26) puts the dashboard on these same
//   rows, the list and GET /schools/:id: the Principal's and the Vice Principals' names,
//   the counts of Students, Teachers, Principals and Vice Principals, and the Principal
//   Applications waiting. One School at a time, each in its own scope, with no cache: a
//   body holds tens of Schools. A Guardian is never counted or named to the body.
// - A School switched off says why and whose deactivation it is (2026-10-26, from the
//   frontend's note; ticket 08's follow-up): deactivationReason, and deactivatedByPlatform
//   for the brake, which the body may not undo. Before, the button learnt it from the 409.
//   The Platform Admin's reason is shown to the body as it is to the Principal on
//   /users/me: the body runs the School above the Principal.

const SCHOOL_SUBJECT = 'School';
const MISSING = 'School not found';
const HAD_PRINCIPAL = 'This school has had a Principal, so its governing body can no longer fix its name, NPSN or type';

// A Principal now or before, whatever became of them: ENDED by a handover (ADR-0008) or
// by the Governing Body (ticket 08), or ACTIVE on a membership that has ended, which
// keeps its roles as history (ApprovalStatus in schema.prisma). An application still
// waiting, refused or taken back never held the office.
const EVER_PRINCIPAL = { role: 'PRINCIPAL', status: { in: ['ACTIVE', 'ENDED'] } };

const ownSchoolSelect = {
    id: true,
    npsn: true,
    name: true,
    schoolType: true,
    durationYears: true,
    city: true,
    latitude: true,
    longitude: true,
    timeZone: true,
    subdomain: true,
    schoolCode: true,
    deactivatedAt: true,
    deactivationReason: true,
    deactivatedByAdminId: true,
    createdAt: true,
    updatedAt: true,
};

// The roles a row counts, and the key each is counted under (ticket 07): one count per
// role held, ACTIVE on an ACTIVE membership, so a Vice Principal who teaches counts twice.
const COUNTED_ROLES = {
    STUDENT: 'students',
    TEACHER: 'teachers',
    PRINCIPAL: 'principals',
    VICE_PRINCIPAL: 'vicePrincipals',
};
const HELD = { status: 'ACTIVE', membership: { status: 'ACTIVE' } };
// A Vice Principal sitting now, as SITTING_PRINCIPAL reads the Principal.
const SITTING_VICE_PRINCIPAL = { role: 'VICE_PRINCIPAL', ...HELD };
const holderNameSelect = { membership: { select: { user: { select: { fullName: true } } } } };

// A School just created: nobody in it, nobody ever its Principal, no application waiting.
const NEW_SCHOOL_FIGURES = {
    hasPrincipal: false,
    hadPrincipal: false,
    principal: null,
    vicePrincipals: [],
    counts: { students: 0, teachers: 0, principals: 0, vicePrincipals: 0 },
    principalApplicationsWaiting: 0,
};

const ownSchoolView = (school, figures) => ({
    id: school.id,
    npsn: school.npsn,
    name: school.name,
    schoolType: school.schoolType,
    durationYears: school.durationYears,
    city: school.city,
    latitude: school.latitude,
    longitude: school.longitude,
    timeZone: school.timeZone,
    subdomain: school.subdomain,
    schoolCode: school.schoolCode,
    hasPrincipal: figures.hasPrincipal,
    hadPrincipal: figures.hadPrincipal,
    principal: figures.principal,
    vicePrincipals: figures.vicePrincipals,
    counts: figures.counts,
    principalApplicationsWaiting: figures.principalApplicationsWaiting,
    deactivatedAt: school.deactivatedAt,
    deactivationReason: school.deactivationReason,
    deactivatedByPlatform: school.deactivatedByAdminId !== null,
    createdAt: school.createdAt,
});

// "Row 2" or "Rows 2, 4": counted from 1, for the person who filled the form.
const rowsLabel = (rows) => (rows.length === 1 ? `Row ${rows[0]}` : `Rows ${rows.join(', ')}`);

const principalOf = (client, where) => client.membershipRole.findFirst({ where, select: { id: true } });

// What a School's row says of its people, read in its own scope: whether a Principal
// sits and whether one ever sat, the Principal's and the Vice Principals' names, the
// counts (ticket 07), and the Principal Applications waiting there.
const figuresAt = (school) =>
    runInSchool(school.id, school.name, async () => {
        const [principal, everPrincipal, vicePrincipals, held, waiting] = await Promise.all([
            prisma.membershipRole.findFirst({ where: SITTING_PRINCIPAL, select: holderNameSelect }),
            principalOf(prisma, EVER_PRINCIPAL),
            prisma.membershipRole.findMany({
                where: SITTING_VICE_PRINCIPAL,
                select: holderNameSelect,
                orderBy: { membership: { user: { fullName: 'asc' } } },
            }),
            prisma.membershipRole.groupBy({
                by: ['role'],
                where: { role: { in: Object.keys(COUNTED_ROLES) }, ...HELD },
                _count: { _all: true },
            }),
            prisma.principalApplication.count({ where: { schoolId: school.id, status: 'PENDING' } }),
        ]);

        const counts = { ...NEW_SCHOOL_FIGURES.counts };
        for (const row of held) counts[COUNTED_ROLES[row.role]] = row._count._all;

        return {
            hasPrincipal: Boolean(principal),
            hadPrincipal: Boolean(everPrincipal),
            principal: principal ? { fullName: principal.membership.user.fullName } : null,
            vicePrincipals: vicePrincipals.map((holder) => ({ fullName: holder.membership.user.fullName })),
            counts,
            principalApplicationsWaiting: waiting,
        };
    });

// Whether a School has ever had one, read in its own scope.
const hasHadPrincipalAt = (school) =>
    runInSchool(school.id, school.name, async () => Boolean(await principalOf(prisma, EVER_PRINCIPAL)));

// One of the body's own Schools. Another body's, or none, is the same 404.
async function loadOwnSchool(auth, id) {
    const school = await prisma.school.findFirst({
        where: { id, governingBodyId: auth.governingBodyId },
        select: ownSchoolSelect,
    });
    if (!school) throw notFound(MISSING);
    return school;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

// POST /api/governing-body/schools, for any admin of the body. Refuses the whole
// submission, naming every row, when an NPSN is taken; writes the Schools and their
// CREATE rows in one transaction.
async function createSchools(auth, { schools: rows }) {
    const taken = await npsnsTakenOf(rows.map((row) => row.npsn));
    const refused = rows
        .map((row, index) => ({ row: index + 1, index, npsn: row.npsn }))
        .filter((entry) => taken.has(entry.npsn));
    if (refused.length) {
        const label = rowsLabel(refused.map((entry) => entry.row));
        const message =
            refused.length === 1
                ? `${label}: ${NPSN_TAKEN}`
                : `${label}: these NPSNs are already registered or under review`;
        throw conflict(message, { rows: refused });
    }

    // Above tenancy, as a School Registration's approval is: the Schools do not exist
    // yet, and each audit row names its own.
    const created = await runUnscoped('a governing body founding its schools', async () => {
        try {
            return await prisma.$transaction(async (tx) => {
                const made = [];
                for (const row of rows) {
                    const school = await createSchool(tx, {
                        npsn: row.npsn,
                        name: row.schoolName,
                        schoolType: row.schoolType,
                        durationYears: row.durationYears,
                        city: row.city,
                        latitude: row.latitude,
                        longitude: row.longitude,
                        timeZone: row.timeZone,
                        governingBodyId: auth.governingBodyId,
                    });

                    await recordAudit({
                        schoolId: school.id,
                        subjectType: SCHOOL_SUBJECT,
                        subjectId: school.id,
                        action: 'CREATE',
                        actorUserId: auth.userId,
                        client: tx,
                    });
                    // Its time under the body begins with it (ticket 08's history).
                    await tx.schoolAffiliation.create({
                        data: {
                            schoolId: school.id,
                            governingBodyId: auth.governingBodyId,
                            began: 'CREATED',
                            startedByUserId: auth.userId,
                        },
                    });

                    made.push(school);
                }
                return made;
            });
        } catch (error) {
            // A School or a registration took one of these NPSNs between the check and
            // the write: the unique index refuses, and nothing is created.
            if (error?.code === 'P2002' && String(error.meta?.target ?? '').includes('npsn')) {
                throw conflict('One of these NPSNs was registered meanwhile, so no school was created');
            }
            throw error;
        }
    });

    log.info(`A governing body created ${created.length} school(s): ${created.map((s) => s.subdomain).join(', ')}`);
    return created.map((school) => ownSchoolView(school, NEW_SCHOOL_FIGURES));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// GET /api/governing-body/schools: the body's Schools, by name, each with its code and
// its figures - the dashboard (ticket 07). A deactivated one is listed, marked.
async function listOwnSchools(auth) {
    const schools = await prisma.school.findMany({
        where: { governingBodyId: auth.governingBodyId },
        select: ownSchoolSelect,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });

    // One School at a time (the plan, owner 2026-10-26): each already reads five small
    // queries at once, and a body holds tens of Schools.
    const rows = [];
    for (const school of schools) rows.push(ownSchoolView(school, await figuresAt(school)));
    return rows;
}

// GET /api/governing-body/schools/:id: one of them, its row as the list gives it, the
// city, point and time zone included (ticket 07).
async function getOwnSchool(auth, id) {
    const school = await loadOwnSchool(auth, id);
    return ownSchoolView(school, await figuresAt(school));
}

// ---------------------------------------------------------------------------
// Fixing
// ---------------------------------------------------------------------------

// The duration after a fix: an SMK's is chosen, 3 or 4; every other type's is fixed by
// the type (shared/schoolType.js). A School turned into an SMK states its own.
function durationAfter(school, patch) {
    const schoolType = patch.schoolType ?? school.schoolType;

    if (patch.durationYears === undefined) {
        if (schoolType === school.schoolType) return school.durationYears;
        if (schoolType === 'SMK') throw badRequest('An SMK must state its duration: 3 or 4 years');
        return SCHOOL_TYPES[schoolType].defaultDurationYears;
    }
    if (!isValidDurationYears(schoolType, patch.durationYears)) {
        const { defaultDurationYears } = SCHOOL_TYPES[schoolType];
        const message =
            schoolType === 'SMK' ? 'An SMK runs 3 or 4 years' : `A ${schoolType} runs ${defaultDurationYears} years`;
        throw badRequest(message);
    }
    return patch.durationYears;
}

// PATCH /api/governing-body/schools/:id, for any admin of the body, while the School has
// never had a Principal (409 once it has, even after they are gone). An NPSN taken gets
// the vague answer; nothing changing writes nothing. The subdomain stays (K9). Audited
// UPDATE_SCHOOL.
async function fixSchool(auth, id, patch) {
    const school = await loadOwnSchool(auth, id);
    if (await hasHadPrincipalAt(school)) throw conflict(HAD_PRINCIPAL);

    const next = {
        name: patch.schoolName ?? school.name,
        npsn: patch.npsn ?? school.npsn,
        schoolType: patch.schoolType ?? school.schoolType,
        durationYears: durationAfter(school, patch),
    };
    if (Object.entries(next).every(([field, value]) => school[field] === value)) {
        return ownSchoolView(school, await figuresAt(school));
    }
    if (next.npsn !== school.npsn && (await npsnsTakenOf([next.npsn], { exceptSchoolId: id })).size) {
        throw conflict(NPSN_TAKEN);
    }

    await runInSchool(school.id, school.name, async () => {
        try {
            await prisma.$transaction(async (tx) => {
                // A claim on the row as it was read, which also holds it until the commit.
                // A fix made meanwhile moved updatedAt, and so will a Principal application or
                // its approval: ticket 06 takes the School row as its lock (lockSchool in
                // membership).
                const claimed = await tx.school.updateMany({
                    where: { id: school.id, governingBodyId: auth.governingBodyId, updatedAt: school.updatedAt },
                    data: next,
                });
                if (claimed.count === 0) throw conflict('This school changed meanwhile');
                if (await principalOf(tx, EVER_PRINCIPAL)) throw conflict(HAD_PRINCIPAL);

                await recordAudit({
                    schoolId: school.id,
                    subjectType: SCHOOL_SUBJECT,
                    subjectId: school.id,
                    action: 'UPDATE_SCHOOL',
                    actorUserId: auth.userId,
                    reason: `Was "${school.name}", ${school.npsn}, ${school.schoolType}, ${school.durationYears} years`,
                    client: tx,
                });
            });
        } catch (error) {
            if (error?.code === 'P2002') throw conflict(NPSN_TAKEN);
            throw error;
        }
    });

    log.info(`${next.name} (${next.npsn}) fixed by its governing body`);
    const fixed = await loadOwnSchool(auth, id);
    return ownSchoolView(fixed, await figuresAt(fixed));
}

export { loadOwnSchool, createSchools, listOwnSchools, getOwnSchool, fixSchool };
