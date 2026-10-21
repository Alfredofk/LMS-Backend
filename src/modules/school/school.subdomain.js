import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
import { recordAudit } from '../../shared/approval.js';
import { isReservedSubdomain, schoolSubdomainCandidatesOf } from '../../shared/subdomain.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('School');

// A School's subdomain (governing-body ticket 02): the label that names the Place a
// sign-in is for, under the platform's base domain.
//
// Owner's decisions (2026-10-18, K9 / K14; the build plan, 2026-10-21):
// - Given at creation by the K9 rule (src/shared/subdomain.js); it does not follow a
//   rename. Every School has one: the column is required, and the Schools from before
//   the ticket got theirs from prisma/backfill-school-subdomains.js.
// - Only a Platform Admin changes it, keyed by the School, audited UPDATE_SUBDOMAIN
//   with what it was. The old one stops resolving at once.
// - A subdomain that is unknown, or a deactivated School's, answers as unknown - the
//   same 404 - to the public read and to a sign-in that names it.
// - A subdomain is public (it is in the address bar), so reading one grants nothing
//   and needs no limiter beyond generalLimiter.

const SCHOOL_SUBJECT = 'School';

// How many K9 candidates are checked against the table in one read.
const CANDIDATES_AT_ONCE = 20;

const UNKNOWN = 'No school uses this address';

const placeView = (school) => ({ kind: 'SCHOOL', name: school.name, schoolType: school.schoolType });

// The first K9 candidate neither reserved nor held by another School. client is a
// transaction's when the School is created in one. A School created at the same
// moment with the same base can still take it first: the unique index refuses the
// second, whose caller answers 409, as generateSchoolCode's would.
async function freeSubdomainOf(client, school) {
    const candidates = schoolSubdomainCandidatesOf(school);
    for (;;) {
        const page = [];
        while (page.length < CANDIDATES_AT_ONCE) {
            const candidate = candidates.next().value;
            if (!isReservedSubdomain(candidate)) page.push(candidate);
        }

        const held = await client.school.findMany({ where: { subdomain: { in: page } }, select: { subdomain: true } });
        const taken = new Set(held.map((row) => row.subdomain));
        const free = page.find((candidate) => !taken.has(candidate));
        if (free) return free;
    }
}

// The School a subdomain names, while it runs. School is above tenancy, so this
// reads with or without a scope; a sign-in calls it before any exists.
async function loadSchoolBySubdomain(subdomain) {
    const school = await prisma.school.findUnique({
        where: { subdomain: subdomain.toLowerCase() },
        select: { id: true, name: true, schoolType: true, subdomain: true, deactivatedAt: true },
    });
    if (!school || school.deactivatedAt) throw notFound(UNKNOWN);
    return school;
}

// GET /api/places/:subdomain, for the page a subdomain opens: whose it is, before
// anyone signs in. Ticket 03 adds a Governing Body's here.
async function resolvePlace(subdomain) {
    return placeView(await loadSchoolBySubdomain(subdomain));
}

// A Platform Admin giving a School another subdomain. Its shape is the schema's to
// check; a reserved word is refused here (400), one another School holds by the
// claim's unique index (409). Setting the one it has is not a change, and refused.
async function changeSubdomain(adminUserId, schoolId, { subdomain }) {
    if (isReservedSubdomain(subdomain)) throw badRequest(`"${subdomain}" is reserved for the platform`);

    return runUnscoped('a platform admin changing a school subdomain', async () => {
        const school = await prisma.school.findUnique({
            where: { id: schoolId },
            select: { id: true, name: true, subdomain: true },
        });
        if (!school) throw notFound('School not found');
        if (school.subdomain === subdomain) throw conflict(`${school.name} already uses "${subdomain}"`);

        try {
            await prisma.$transaction(async (tx) => {
                const claimed = await tx.school.updateMany({
                    where: { id: school.id, subdomain: school.subdomain },
                    data: { subdomain },
                });
                if (claimed.count === 0) throw conflict('This school’s subdomain changed meanwhile');

                await recordAudit({
                    schoolId: school.id,
                    subjectType: SCHOOL_SUBJECT,
                    subjectId: school.id,
                    action: 'UPDATE_SUBDOMAIN',
                    actorUserId: adminUserId,
                    reason: `Was "${school.subdomain}"`,
                    client: tx,
                });
            });
        } catch (error) {
            if (error?.code === 'P2002') throw conflict(`"${subdomain}" is taken by another school`);
            throw error;
        }

        log.info(`Subdomain of ${school.name} changed to ${subdomain}`);
        return { id: school.id, name: school.name, subdomain };
    });
}

export { freeSubdomainOf, loadSchoolBySubdomain, resolvePlace, changeSubdomain };
