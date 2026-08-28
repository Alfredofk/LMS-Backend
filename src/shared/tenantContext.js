'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Carries the current school across the whole request without threading it
 * through every function signature. The auth middleware opens the scope; the
 * Prisma extension in ./prisma.js reads it.
 *
 * Nothing else should read this directly. If a service needs to know which
 * school it is in, take it from the authenticated membership instead - the
 * ambient value exists so queries cannot forget it, not as a global variable.
 */

const storage = new AsyncLocalStorage();

/** Run `fn` with every tenant-owned query scoped to this school. */
function runInSchool(schoolId, fn) {
    if (!schoolId) throw new Error('runInSchool requires a schoolId');
    return storage.run({ schoolId, unscoped: false, reason: null }, fn);
}

/**
 * Deliberately step outside tenant isolation.
 *
 * This is the only way to read across schools, so it is loud on purpose:
 * `reason` is required and ends up in the log. Legitimate callers are the seed
 * script, the test harness, platform-admin routes, and the school-code lookup
 * (which must find a school before the caller belongs to one).
 */
function runUnscoped(reason, fn) {
    if (!reason) throw new Error('runUnscoped requires a reason');
    return storage.run({ schoolId: null, unscoped: true, reason }, fn);
}

function getContext() {
    return storage.getStore() ?? null;
}

function getSchoolId() {
    return storage.getStore()?.schoolId ?? null;
}

function isUnscoped() {
    return storage.getStore()?.unscoped === true;
}

module.exports = {
    runInSchool,
    runUnscoped,
    getContext,
    getSchoolId,
    isUnscoped,
};
