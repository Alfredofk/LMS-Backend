/*
  Carries the current school across the whole request without threading it
  through every function signature. The auth middleware opens the scope; the
  Prisma extension in ./prisma.js and the logger in ../lib/helpers.js read it.
*/

import { AsyncLocalStorage } from 'node:async_hooks';
const storage = new AsyncLocalStorage();

function runInSchool(schoolId, schoolName, fn) {
    if (!schoolId) throw new Error('runInSchool requires a schoolId');
    return storage.run({ schoolId, schoolName: schoolName, unscoped: false, reason: null }, fn);
}

function runUnscoped(reason, fn) {
    if (!reason) throw new Error('runUnscoped requires a reason');
    return storage.run({ schoolId: null, schoolName: null, unscoped: true, reason }, fn);
}

function getContext() {
    return storage.getStore() ?? null;
}

function getSchoolId() {
    return storage.getStore()?.schoolId ?? null;
}

function getSchoolName() {
    return storage.getStore()?.schoolName ?? null;
}

function isUnscoped() {
    return storage.getStore()?.unscoped === true;
}

export {
    runInSchool,
    runUnscoped,
    getContext,
    getSchoolId,
    getSchoolName,
    isUnscoped,
};
