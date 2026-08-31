import { PrismaClient } from '@prisma/client';
import { getSchoolId, isUnscoped } from './tenantContext.js';

/*
  Multi-tenant isolation (ADR-0001).

  Every tenant-owned table carries `schoolId`, and this extension injects it into
  every read and every write. Isolation is structural: forgetting a filter is not
  possible by default, and stepping outside it requires runUnscoped() with a reason.

  The data here includes minors' academic records. A missed filter is a disclosure,
  not a bug, which is why this fails closed - a tenant-owned query with no ambient
  school throws rather than returning every school's rows.
*/

/*
  Identity lives above tenancy, and these three define or predate the tenant, so
  none of them can be filtered by it.
*/
const UNSCOPED_MODELS = new Set([
    'User',
    'EmailVerificationToken',
    'PasswordResetToken',
    'PlatformAdmin',
    'SchoolRegistration',
    'School',
]);

/*
  Subject is nullable-tenant: rows with schoolId = null are the national catalog
  shared by every school, rows with a schoolId are that school's local subjects.
  Reads must see both; writes create a local subject.
*/
const CATALOG_MODELS = new Set(['Subject']);

const WHERE_OPS = new Set([
    'findFirst',
    'findFirstOrThrow',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
    'update',
    'updateMany',
    'delete',
    'deleteMany',
]);

// Rewritten to their findFirst equivalents so the filter is always legal.
const UNIQUE_READ_OPS = new Map([
    ['findUnique', 'findFirst'],
    ['findUniqueOrThrow', 'findFirstOrThrow'],
]);

const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

const and = (existing, extra) =>
    existing ? { AND: [existing, extra] } : extra;

const withSchool = (schoolId) => ({ schoolId });

const withCatalog = (schoolId) => ({
    OR: [{ schoolId: null }, { schoolId }],
});

function stampCreateData(data, schoolId) {
    if (Array.isArray(data)) {
        return data.map((row) => ({ ...row, schoolId }));
    }
    return { ...data, schoolId };
}

function buildClient() {
    const base = new PrismaClient({
        log: ['error'],
    });

    return base.$extends({
        name: 'tenantIsolation',
        query: {
            $allModels: {
                async $allOperations({ model, operation, args, query }) {
                    if (UNSCOPED_MODELS.has(model) || isUnscoped()) {
                        return query(args);
                    }

                    const schoolId = getSchoolId();
                    if (!schoolId) {
                        throw new Error(
                            `Tenant isolation: ${model}.${operation} ran with no school in ` +
                                'context. Wrap the call in runInSchool(), or in runUnscoped() ' +
                                'with a reason if it is genuinely cross-tenant.'
                        );
                    }

                    const isCatalog = CATALOG_MODELS.has(model);
                    const scope = isCatalog ? withCatalog(schoolId) : withSchool(schoolId);
                    const next = { ...args };

                    // findUnique cannot always carry a non-unique filter, so read
                    // it as findFirst instead. Equality on an indexed column still
                    // uses the index; only the API surface changes.
                    if (UNIQUE_READ_OPS.has(operation)) {
                        return base[model][UNIQUE_READ_OPS.get(operation)]({
                            ...next,
                            where: and(next.where, scope),
                        });
                    }

                    if (WHERE_OPS.has(operation)) {
                        next.where = and(next.where, scope);
                        return query(next);
                    }

                    if (CREATE_OPS.has(operation)) {
                        // A created row always belongs to the current school, even
                        // for Subject: the national catalog is seeded unscoped.
                        next.data = stampCreateData(next.data, schoolId);
                        return query(next);
                    }

                    if (operation === 'upsert') {
                        next.where = and(next.where, scope);
                        next.create = { ...next.create, schoolId };
                        return query(next);
                    }

                    // Unrecognised operation: refuse rather than let it through
                    // unfiltered. A new Prisma operation should fail loudly here.
                    throw new Error(
                        `Tenant isolation: unhandled operation ${model}.${operation}. ` +
                            'Add it to prisma.js before using it.'
                    );
                },
            },
        },
    });
}

const prisma = buildClient();

export {
    prisma,
    UNSCOPED_MODELS,
    CATALOG_MODELS,
};
