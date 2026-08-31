import { prisma } from './prisma.js';
import { forbidden, notFound } from './errors.js';

/*
  Resource-scoped authorization.

  This is the real access control. requireRole() in ./auth.js only narrows who
  may reach a handler; these answer the question that actually protects a
  student's record: "is THIS teacher assigned to THIS class subject?"

  Every query here runs inside the tenant scope, so a resource belonging to
  another school simply is not found - the guards never need to compare school
  ids themselves, and cannot forget to.
*/

// Does this membership hold this role, approved and active?
async function hasActiveRole(membershipId, role) {
    const found = await prisma.membershipRole.findFirst({
        where: { membershipId, role, status: 'ACTIVE' },
        select: { id: true },
    });
    return Boolean(found);
}

async function isPrincipal(membershipId) {
    return hasActiveRole(membershipId, 'PRINCIPAL');
}

/*
  Homeroom teacher of this specific class.

  Not a role - it is a property of the class. That is why this takes a classId:
  a role string could never say WHICH class, and "is a homeroom teacher
  somewhere" is not an authorization anyone should have.
*/
async function isHomeroomOf(membershipId, classId) {
    const found = await prisma.class.findFirst({
        where: { id: classId, homeroomTeacherMembershipId: membershipId },
        select: { id: true },
    });
    return Boolean(found);
}

// Assigned teacher of an ACTIVE class subject. PENDING grants nothing.
async function isTeacherOfClassSubject(membershipId, classSubjectId) {
    const found = await prisma.classSubject.findFirst({
        where: { id: classSubjectId, teacherMembershipId: membershipId, status: 'ACTIVE' },
        select: { id: true },
    });
    return Boolean(found);
}

// Guardian access derives from the link, never from holding the GUARDIAN role.
async function isGuardianOf(membershipId, studentProfileId) {
    const found = await prisma.guardianStudent.findFirst({
        where: {
            guardianMembershipId: membershipId,
            studentProfileId,
            status: 'ACTIVE',
            endedAt: null,
        },
        select: { id: true },
    });
    return Boolean(found);
}

// The homeroom teacher who may decide a student's or guardian's join request.
async function isHomeroomOfStudent(membershipId, studentProfileId) {
    const placement = await prisma.classMembership.findFirst({
        where: { studentProfileId, endedAt: null },
        select: { classId: true },
    });
    if (!placement) return false;
    return isHomeroomOf(membershipId, placement.classId);
}

/*
  Express middleware factory. Reads the resource id from req.params and refuses
  with 404 rather than 403 when the check fails for a resource that may simply
  belong to another school - a 403 would confirm it exists (ADR-0001).
*/
function requireResource(check, { param = 'id', message } = {}) {
    return async (req, _res, next) => {
        const membershipId = req.auth?.membershipId;
        if (!membershipId) return next(forbidden('You are not an active member of any school'));

        const resourceId = req.params[param];
        if (!resourceId) return next(notFound());

        try {
            const allowed = await check(membershipId, resourceId);
            return allowed ? next() : next(notFound(message));
        } catch (error) {
            return next(error);
        }
    };
}

export {
    hasActiveRole,
    isPrincipal,
    isHomeroomOf,
    isHomeroomOfStudent,
    isTeacherOfClassSubject,
    isGuardianOf,
    requireResource,
};
