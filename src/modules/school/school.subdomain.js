import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
import { recordAudit } from '../../shared/approval.js';
import {
    isReservedSubdomain,
    schoolSubdomainCandidatesOf,
    governingBodySubdomainCandidatesOf,
} from '../../shared/subdomain.js';
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
// - A Governing Body's subdomain (ticket 03, K13) lives in the same space: unique
//   across both tables, resolved by the same route, named by a sign-in the same way.

const SCHOOL_SUBJECT = 'School';

// How many candidates are checked against the tables in one read.
const CANDIDATES_AT_ONCE = 20;

const UNKNOWN = 'No school uses this address';

const placeView = (place) =>
    place.kind === 'SCHOOL'
        ? { kind: place.kind, name: place.name, schoolType: place.schoolType }
        : { kind: place.kind, name: place.name, governingBodyKind: place.governingBodyKind };

// Which of these labels a School or a Governing Body holds.
async function heldOf(client, labels) {
    const [schools, bodies] = await Promise.all([
        client.school.findMany({ where: { subdomain: { in: labels } }, select: { subdomain: true } }),
        client.governingBody.findMany({ where: { subdomain: { in: labels } }, select: { subdomain: true } }),
    ]);
    return new Set([...schools, ...bodies].map((row) => row.subdomain));
}

// The first candidate neither reserved nor held. client is a transaction's when the
// Place is created in one. One created at the same moment with the same base can still
// take it first: the unique index refuses the second, whose caller answers 409, as
// generateSchoolCode's would.
async function firstFreeOf(client, candidates) {
    for (;;) {
        const page = [];
        while (page.length < CANDIDATES_AT_ONCE) {
            const candidate = candidates.next().value;
            if (!isReservedSubdomain(candidate)) page.push(candidate);
        }

        const held = await heldOf(client, page);
        const free = page.find((candidate) => !held.has(candidate));
        if (free) return free;
    }
}

// A School's K9 subdomain, and a Governing Body's K13 one.
const freeSubdomainOf = (client, school) => firstFreeOf(client, schoolSubdomainCandidatesOf(school));
const freeGoverningBodySubdomainOf = (client, body) => firstFreeOf(client, governingBodySubdomainCandidatesOf(body));

// The Place a subdomain names, while it runs: a School, or a Governing Body (ticket
// 03). Both are above tenancy, so this reads with or without a scope; a sign-in calls
// it before any exists.
async function loadPlaceBySubdomain(subdomain) {
    const label = subdomain.toLowerCase();
    const [school, body] = await Promise.all([
        prisma.school.findUnique({
            where: { subdomain: label },
            select: { id: true, name: true, schoolType: true, subdomain: true, deactivatedAt: true },
        }),
        prisma.governingBody.findUnique({
            where: { subdomain: label },
            select: { id: true, name: true, kind: true, subdomain: true, deactivatedAt: true },
        }),
    ]);

    if (school && !school.deactivatedAt) return { kind: 'SCHOOL', ...school };
    if (body && !body.deactivatedAt) {
        return {
            kind: 'GOVERNING_BODY',
            id: body.id,
            name: body.name,
            governingBodyKind: body.kind,
            subdomain: body.subdomain,
        };
    }
    throw notFound(UNKNOWN);
}

// GET /api/places/:subdomain, for the page a subdomain opens: whose it is, before
// anyone signs in.
async function resolvePlace(subdomain) {
    return placeView(await loadPlaceBySubdomain(subdomain));
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
        // A Governing Body's is in the same space, and no index spans the two tables.
        if ((await heldOf(prisma, [subdomain])).has(subdomain)) {
            throw conflict(`"${subdomain}" is taken by another school or governing body`);
        }

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

export { freeSubdomainOf, freeGoverningBodySubdomainOf, loadPlaceBySubdomain, resolvePlace, changeSubdomain };
