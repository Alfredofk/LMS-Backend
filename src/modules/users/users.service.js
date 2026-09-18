import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
import { hashPassword, verifyPassword } from '../../shared/auth.js';
import { notFound, unauthorized } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';
import {
    publicUser,
    issueRefreshToken,
    revokeAllRefreshTokens,
    authResponse,
} from '../auth/auth.service.js';

const log = createLogger('Users');

/*
  What a member is allowed to know about their own standing, and nothing more.

  A PENDING member sees their status, the name of the school they asked to join,
  and which roles they requested - that is the whole point of the endpoint, since
  otherwise a person waiting on approval has no way to tell whether anything is
  happening. They see no roster, no classes, no other member: this reads their
  own membership row by userId and never opens a school scope, so nothing
  tenant-owned is reachable from the token they hold (ADR-0001).

  Unscoped for the same reason buildAuthClaims is: a PENDING user's token carries
  no schoolId, so there is no ambient school for the extension to filter by.
*/
async function loadMembership(userId) {
    return runUnscoped('reading a user own membership status', async () => {
        const membership = await prisma.schoolMembership.findFirst({
            where: { userId, status: { in: ['PENDING', 'ACTIVE'] } },
            select: {
                id: true,
                status: true,
                requestedAt: true,
                approvedAt: true,
                school: { select: { id: true, name: true, schoolType: true } },
                roles: {
                    select: { role: true, status: true, rejectionReason: true },
                    orderBy: { role: 'asc' },
                },
            },
        });

        if (!membership) return null;

        return {
            id: membership.id,
            status: membership.status,
            requestedAt: membership.requestedAt,
            approvedAt: membership.approvedAt,
            school: membership.school,
            roles: membership.roles,
        };
    });
}

async function loadUser(userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw notFound('Account not found');
    return user;
}

async function getMe(userId) {
    const user = await loadUser(userId);
    return { user: publicUser(user), membership: await loadMembership(userId) };
}

async function updateMe(userId, { fullName }) {
    await loadUser(userId);

    const user = await prisma.user.update({
        where: { id: userId },
        data: { fullName },
    });

    return { user: publicUser(user), membership: await loadMembership(userId) };
}

/*
  Changing a password signs out every device, then signs this one back in.

  Cutting them all is the point: if the reason for the change is that someone
  else had the old password, a sign-in they already hold must not outlive it. The
  caller gets a new pair back so the person doing the right thing is not signed
  out of the device they are typing on.

  The access token already in flight is untouched and lives out its remaining
  minutes - the accepted cost of a stateless access token, and why the tenant
  guards in guards.js read status from the database rather than from claims.
*/
async function changePassword(userId, { currentPassword, newPassword }) {
    const user = await loadUser(userId);

    const matches = await verifyPassword(currentPassword, user.passwordHash);
    if (!matches) throw unauthorized('Current password is incorrect');

    const updated = await prisma.user.update({
        where: { id: userId },
        data: { passwordHash: await hashPassword(newPassword) },
    });

    await revokeAllRefreshTokens(userId);
    const { token } = await issueRefreshToken(userId);

    log.success(`Password changed for ${user.email}`);

    return authResponse(updated, token);
}

export { loadMembership, getMe, updateMe, changePassword };
