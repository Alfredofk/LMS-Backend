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
    createdAt: true,
    updatedAt: true,
};

// A School just created, or one a fix went through: neither has ever had a Principal.
const NO_PRINCIPAL_EVER = { hasPrincipal: false, hadPrincipal: false };

const ownSchoolView = (school, { hasPrincipal, hadPrincipal }) => ({
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
    hasPrincipal,
    hadPrincipal,
    deactivatedAt: school.deactivatedAt,
    createdAt: school.createdAt,
});

// "Row 2" or "Rows 2, 4": counted from 1, for the person who filled the form.
const rowsLabel = (rows) => (rows.length === 1 ? `Row ${rows[0]}` : `Rows ${rows.join(', ')}`);

const principalOf = (client, where) => client.membershipRole.findFirst({ where, select: { id: true } });

// Whether a School has a Principal now and whether it has ever had one, read in its own
// scope. One that never had one has none now, so it costs a single read.
const principalStandingAt = (school) =>
    runInSchool(school.id, school.name, async () => {
        const hadPrincipal = Boolean(await principalOf(prisma, EVER_PRINCIPAL));
        const hasPrincipal = hadPrincipal && Boolean(await principalOf(prisma, SITTING_PRINCIPAL));
        return { hasPrincipal, hadPrincipal };
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
    return created.map((school) => ownSchoolView(school, NO_PRINCIPAL_EVER));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// GET /api/governing-body/schools: the body's Schools, by name, each with its code,
// whether it has a Principal and whether it ever had one. Ticket 07 adds the numbers.
async function listOwnSchools(auth) {
    const schools = await prisma.school.findMany({
        where: { governingBodyId: auth.governingBodyId },
        select: ownSchoolSelect,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const standings = await Promise.all(schools.map(principalStandingAt));
    return schools.map((school, index) => ownSchoolView(school, standings[index]));
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
        return ownSchoolView(school, NO_PRINCIPAL_EVER);
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
    return ownSchoolView(await loadOwnSchool(auth, id), NO_PRINCIPAL_EVER);
}

export { createSchools, listOwnSchools, fixSchool };
