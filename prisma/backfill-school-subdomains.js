// One-off, after migration 20261021165119_add_school_subdomain_and_handoff
// (governing-body ticket 02, the owner's option A of 2026-10-21): every School still on
// the placeholder that migration gave it, `npsn<NPSN>`, is given its K9 subdomain,
// oldest School first, so the oldest of two names keeps the bare one.
//
//   node prisma/backfill-school-subdomains.js
//
// Safe to run again: a School already off its placeholder is left as it is, so a
// subdomain a Platform Admin set by hand is never touched. Run it once on every
// database the migration reaches that held Schools before it - locally, and on the
// host after its deploy. School is above tenancy, so nothing here opens a scope.
import 'dotenv/config';

import { prisma } from '../src/shared/prisma.js';
import { freeSubdomainOf } from '../src/modules/school/school.subdomain.js';

const placeholderOf = (school) => `npsn${school.npsn}`;

async function backfill() {
    const schools = await prisma.school.findMany({
        select: { id: true, npsn: true, name: true, schoolType: true, city: true, subdomain: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    let given = 0;
    for (const school of schools) {
        if (school.subdomain !== placeholderOf(school)) continue;

        const subdomain = await freeSubdomainOf(prisma, school);
        await prisma.school.update({ where: { id: school.id }, data: { subdomain } });
        given += 1;
        console.log(`  ${school.name} (${school.npsn}) -> ${subdomain}`);
    }

    console.log(`\n${given} school(s) given a subdomain, ${schools.length - given} already had one.`);
}

backfill()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
