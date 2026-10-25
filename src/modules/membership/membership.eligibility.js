import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
import { conflict } from '../../shared/errors.js';

// Who may hold which membership, across schools (governing-body ticket 01, ADR-0011,
// owner 2026-10-18 K2):
// - one live (PENDING or ACTIVE) membership per person per School, at any number of
//   Schools. The partial unique index SchoolMembership_one_live_per_user_per_school is
//   the ceiling; the check here makes the answer a sentence.
// - a Student holds one membership on the whole platform. Holding STUDENT anywhere
//   refuses any other request, and holding anything refuses a STUDENT request
//   anywhere. This keeps Dapodik's one school per pupil, and ADR-0004's transfer as
//   leave-and-rejoin. No index can say it - it relates a role row to another school's
//   membership - so it is checked when a request is made and again at its approval.
//
// Every read here spans schools, so it runs unscoped: the question is precisely
// "which schools".

const LIVE = ['PENDING', 'ACTIVE'];

// A role counts while it is asked for or held: a STUDENT turned down, cancelled or
// ended belongs to nobody.
async function liveMembershipsOf(client, userId) {
    return runUnscoped('reading which schools a user belongs to or has asked to join', async () =>
        await client.schoolMembership.findMany({
            where: { userId, status: { in: LIVE } },
            select: {
                id: true,
                schoolId: true,
                status: true,
                roles: { where: { status: { in: LIVE } }, select: { role: true } },
            },
        })
    );
}

const holdsStudent = (membership) => membership.roles.some((entry) => entry.role === 'STUDENT');

// Whether a person holds or has asked for an admin seat at any Governing Body. Seats
// are above tenancy, so this reads without a scope.
async function hasLiveSeat(client, userId) {
    const seat = await client.governingBodyAdmin.findFirst({
        where: { userId, status: { in: LIVE } },
        select: { id: true },
    });
    return Boolean(seat);
}

// Whether a person has asked to head a Governing Body's School and waits for the answer
// (governing-body ticket 06). An application counts as asking for a membership: its
// approval makes one. Above tenancy too.
async function hasWaitingPrincipalApplication(client, userId) {
    const application = await client.principalApplication.findFirst({
        where: { userId, status: 'PENDING' },
        select: { id: true },
    });
    return Boolean(application);
}

// What a STUDENT request is refused for beyond the memberships: holding or asking for
// something above the Schools. Worded for the applicant (you) and for the reviewer
// (they), never naming where.
const ABOVE_SCHOOLS = {
    seat: {
        you: 'You are an admin of a governing body, or have asked to be one',
        they: 'This applicant is an admin of a governing body, or has asked to be one',
    },
    application: {
        you: 'You have applied to be the Principal of a school',
        they: 'This applicant has applied to be the Principal of a school',
    },
};

async function standingAboveSchoolsOf(client, userId) {
    if (await hasLiveSeat(client, userId)) return ABOVE_SCHOOLS.seat;
    if (await hasWaitingPrincipalApplication(client, userId)) return ABOVE_SCHOOLS.application;
    return null;
}

// Whether a person is a Student anywhere, or has asked to be. A School Registration
// is refused to them (school.service.js): founding a school makes its founder its
// Principal.
const isStudentAnywhere = async (userId) => (await liveMembershipsOf(prisma, userId)).some(holdsStudent);

// Who may look a School up by its code, and ask to join it. roles is what they ask
// for: none yet at lookup, where only what would refuse any request is checked.
async function assertMayJoin(userId, schoolId, roles = []) {
    const live = await liveMembershipsOf(prisma, userId);

    const here = live.find((membership) => membership.schoolId === schoolId);
    if (here) {
        throw conflict(
            here.status === 'PENDING'
                ? 'You already have a join request waiting for approval at this school'
                : 'You already belong to this school. Ask for another role from your membership instead'
        );
    }
    if (live.some(holdsStudent)) {
        throw conflict(
            'A student belongs to one school only, and you are one at a school or have asked to be'
        );
    }
    if (roles.includes('STUDENT') && live.length > 0) {
        throw conflict(
            'A student belongs to one school only. You already belong to a school, or have asked to join one'
        );
    }
    if (!roles.includes('STUDENT')) return;
    const above = await standingAboveSchoolsOf(prisma, userId);
    if (above) throw conflict(`A student belongs to one school only. ${above.you}`);
}

// The Student rule again at approval, inside the decision's transaction. Two
// requests made at the same moment both pass assertMayJoin; each is a live row from
// its creation, so whichever is approved second finds the other here. releasing is
// the roles this decision makes ACTIVE.
//
// The reviewer learns only that a student membership stands in the way, never at
// which school (ADR-0001).
async function assertStudentAlone(tx, { userId, membershipId, releasing }) {
    const others = (await liveMembershipsOf(tx, userId)).filter((membership) => membership.id !== membershipId);
    const asStudent = releasing.includes('STUDENT');
    const above = asStudent ? await standingAboveSchoolsOf(tx, userId) : null;
    if (above) throw conflict(`${above.they}, and a student belongs to one school only`);
    const clash = asStudent ? others.length > 0 : others.some(holdsStudent);
    if (!clash) return;

    throw conflict(
        asStudent
            ? 'This applicant belongs to another school, or has asked to join one, and a student ' +
                  'belongs to one school only'
            : 'This applicant is a student at another school, or has asked to be one, and a student ' +
                  'belongs to one school only'
    );
}

export { isStudentAnywhere, assertMayJoin, assertStudentAlone };
