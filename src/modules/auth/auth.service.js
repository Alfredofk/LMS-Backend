import crypto from 'node:crypto';

import { prisma } from '../../shared/prisma.js';
import { runUnscoped } from '../../shared/tenantContext.js';
import {
    hashPassword,
    verifyPassword,
    generateToken,
    hashToken,
    signAccessToken,
    signRefreshToken,
    verifyRefreshToken,
} from '../../shared/auth.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../../shared/mailer.js';
import { googleVerifier } from '../../shared/google.js';
import { AppError, badRequest, conflict, unauthorized } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('Auth');

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // matches the wording in mailer.js
const RESET_TTL_MS = 60 * 60 * 1000;

/*
  A bcrypt hash of a value nobody will ever type, compared against when the email
  is unknown.

  Without it, a login for a non-existent account returns in microseconds while a
  wrong password costs a deliberate ~300ms of bcrypt - and that gap alone tells
  an attacker which addresses hold accounts. Created as a promise at import time
  and awaited only on the failing path, so nothing blocks at startup.
*/
const dummyHash = hashPassword(crypto.randomBytes(32).toString('hex'));

const expiresIn = (ms) => new Date(Date.now() + ms);

const publicUser = (user) => ({
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    emailVerifiedAt: user.emailVerifiedAt ?? null,
    createdAt: user.createdAt,
});

/*
  Mail failure never fails the request that triggered it.

  The account, the token and the reset request are already committed; refusing
  the whole call because an SMTP relay was briefly unreachable would strand the
  user with an account they cannot reach and no way to ask again. Both paths that
  send mail have a resend, which is the actual remedy.
*/
async function deliver(context, send) {
    try {
        await send();
    } catch (error) {
        log.error(`Email delivery failed (${context}):`, error);
    }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/*
  The join between authentication and tenancy (ADR-0001), and the one place in
  this module that must step outside the tenant scope.

  SchoolMembership and MembershipRole are tenant-owned, but this runs at login -
  before any school is known, which is precisely what the lookup is trying to
  find out. Scoped, the extension would throw (prisma.js:88). The same carve-out
  seed.js:129 makes, for the same reason.

  Only an ACTIVE membership with ACTIVE roles produces claims. A PENDING member
  gets a token carrying no school at all, so every tenant-owned query they could
  reach throws rather than returning rows.
*/
async function buildAuthClaims(userId) {
    return runUnscoped(
        'resolving a membership before any school scope exists',
        async () => {
            const membership = await prisma.schoolMembership.findFirst({
                where: { userId, status: 'ACTIVE', endedAt: null },
                select: {
                    id: true,
                    schoolId: true,
                    school: { select: { name: true } },
                    roles: {
                        where: { status: 'ACTIVE' },
                        select: { role: true },
                    },
                },
            });

            if (!membership) {
                return { membershipId: null, schoolId: null, schoolName: null, roles: [] };
            }

            return {
                membershipId: membership.id,
                schoolId: membership.schoolId,
                schoolName: membership.school.name,
                roles: membership.roles.map((entry) => entry.role),
            };
        }
    );
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

/*
  The row's expiry is read back out of the JWT rather than recomputed from
  JWT_REFRESH_TTL. One source of truth: change the env value and the table
  follows, with no chance of a row outliving the token it stands for.
*/
async function issueRefreshToken(userId) {
    const token = signRefreshToken({ userId });
    const { exp } = verifyRefreshToken(token);

    const row = await prisma.refreshToken.create({
        data: {
            userId,
            tokenHash: hashToken(token),
            expiresAt: new Date(exp * 1000),
        },
        select: { id: true },
    });

    return { token, id: row.id };
}

// An update, never a delete - a revoked row is the evidence a sign-in happened.
const revokeAllRefreshTokens = (userId) =>
    prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
    });

async function authResponse(user, refreshToken) {
    const claims = await buildAuthClaims(user.id);

    return {
        accessToken: signAccessToken({ userId: user.id, ...claims }),
        refreshToken,
        user: publicUser(user),
        membership: claims.membershipId
            ? {
                  id: claims.membershipId,
                  schoolId: claims.schoolId,
                  schoolName: claims.schoolName,
                  roles: claims.roles,
              }
            : null,
    };
}

// ---------------------------------------------------------------------------
// Registration and verification
// ---------------------------------------------------------------------------

/*
  A taken email answers 409 rather than a vague success.

  That does confirm the address has an account, and it is a deliberate, narrow
  trade: a signup form has to be able to say "this email is already registered"
  or people cannot sign up at all. The endpoints where enumeration actually costs
  something - forgot-password and resend-verification - stay silent.
*/
async function registerUser({ email, password, fullName }) {
    const existing = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
    });

    if (existing) throw conflict('That email is already registered');

    // Two simultaneous registrations still race past the check above; the unique
    // index catches it and server.js:70 turns P2002 into the same 409.
    const user = await prisma.user.create({
        data: { email, passwordHash: await hashPassword(password), fullName },
    });

    await issueVerificationToken(user);
    log.success(`Registered ${user.email}`);

    return publicUser(user);
}

/*
  Issuing a new link retires every outstanding one. "Single-use" has to mean the
  newest link is the only one that works, or a forwarded old email stays live.
*/
async function issueVerificationToken(user) {
    const token = generateToken();

    await prisma.$transaction([
        prisma.emailVerificationToken.updateMany({
            where: { userId: user.id, usedAt: null },
            data: { usedAt: new Date() },
        }),
        prisma.emailVerificationToken.create({
            data: {
                userId: user.id,
                tokenHash: hashToken(token),
                expiresAt: expiresIn(VERIFICATION_TTL_MS),
            },
        }),
    ]);

    await deliver(user.email, () =>
        sendVerificationEmail({ to: user.email, fullName: user.fullName, token })
    );
}

async function verifyEmail(rawToken) {
    const row = await prisma.emailVerificationToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
        include: {
            user: { select: { id: true, email: true, emailVerifiedAt: true, deletedAt: true } },
        },
    });

    // One message for every failure. Which of the four it was is something the
    // caller fixes by asking for a new link, not information worth handing out.
    if (!row || row.usedAt || row.expiresAt <= new Date() || row.user.deletedAt) {
        throw badRequest('This verification link is invalid or has expired');
    }

    const alreadyVerified = Boolean(row.user.emailVerifiedAt);

    await prisma.$transaction([
        prisma.emailVerificationToken.update({
            where: { id: row.id },
            data: { usedAt: new Date() },
        }),
        prisma.user.update({
            where: { id: row.user.id },
            data: { emailVerifiedAt: row.user.emailVerifiedAt ?? new Date() },
        }),
    ]);

    if (!alreadyVerified) log.success(`Email verified: ${row.user.email}`);

    return { alreadyVerified };
}

// Silent on purpose: the caller answers identically whatever this finds.
async function resendVerification(email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.deletedAt || user.emailVerifiedAt) return;

    await issueVerificationToken(user);
}

// ---------------------------------------------------------------------------
// Login, refresh, logout
// ---------------------------------------------------------------------------

async function login({ email, password }) {
    const user = await prisma.user.findUnique({ where: { email } });
    // No passwordHash means an account made through Google that has not set a
    // password yet. It fails exactly like an unknown address, dummy hash and all.
    const usable = user && !user.deletedAt && user.passwordHash;

    const matches = await verifyPassword(password, usable ? user.passwordHash : await dummyHash);

    if (!usable || !matches) throw unauthorized('Email or password is incorrect');

    /*
      A distinct code, not the generic 401. This does reveal that the account
      exists - but only to someone who has just proved they know its password,
      who therefore learns nothing new. The client needs to tell the two apart to
      offer "resend the verification email" instead of "wrong password".
    */
    if (!user.emailVerifiedAt) {
        throw new AppError(
            403,
            'EMAIL_NOT_VERIFIED',
            'Verify your email address before signing in'
        );
    }

    const { token } = await issueRefreshToken(user.id);
    return authResponse(user, token);
}

/*
  Rotation. Every refresh mints a new token and revokes the one presented, so a
  refresh token is good exactly once.

  That is what makes theft detectable: if a revoked token comes back, either the
  legitimate holder replayed it or someone copied it - and there is no way to
  tell which. Signing that user out everywhere is the only safe answer, and costs
  the honest user one login.

  "Session" is not the word for this anywhere in the codebase: CONTEXT.md gives it
  to one meeting of a ClassSubject. A sign-in belongs to a device.
*/
async function refreshAuth(rawToken) {
    const rejected = unauthorized('Invalid or expired refresh token');

    try {
        verifyRefreshToken(rawToken);
    } catch {
        throw rejected;
    }

    const row = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
    });

    if (!row) throw rejected;

    if (row.revokedAt) {
        await revokeAllRefreshTokens(row.userId);
        log.warn(`Refresh token reuse for user ${row.userId} - signed out everywhere`);
        throw rejected;
    }

    if (row.expiresAt <= new Date()) throw rejected;

    const user = await prisma.user.findUnique({ where: { id: row.userId } });
    if (!user || user.deletedAt || !user.emailVerifiedAt) throw rejected;

    const issued = await issueRefreshToken(user.id);
    await prisma.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date(), replacedByTokenId: issued.id },
    });

    // Claims are rebuilt here, not carried over. This is the moment an approval
    // granted since the last login actually reaches the user's token.
    return authResponse(user, issued.token);
}

/*
  Idempotent. Logging out twice, or with a token we never issued, is not a
  condition worth reporting - the caller's intent is satisfied either way, and a
  404 here would confirm which tokens are real.
*/
async function logout(rawToken) {
    const row = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
        select: { id: true, revokedAt: true },
    });

    if (!row || row.revokedAt) return;

    await prisma.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
    });
}

// ---------------------------------------------------------------------------
// Google sign-in (ADR-0005)
// ---------------------------------------------------------------------------

const googleRejected = () => unauthorized('Google sign-in failed');

// Google's name when it sends one, else the part of the address before the @.
const googleFullName = (name, email) => (name?.trim() || email.split('@')[0]).slice(0, 120);

/*
  Which User a verified Google identity signs in as.

  The link is googleSub, never the email: a Google account can change its
  address, and its sub never changes. The email is only consulted the first
  time, to find the account this Google identity should attach to.

  Three outcomes the first time:
    - no account for the address  -> one is created, already verified
    - a verified account          -> linked, its password untouched
    - an UNVERIFIED account       -> linked, and its password discarded

  The last is the one that matters. Anyone can register an address they do not
  own; it just stays unverified. If the real owner later arrives through Google,
  that account becomes verified - and without this, the stranger's password
  would now open it. So the password goes, every refresh token issued against
  it goes, and any verification link still sitting in the inbox is retired.
  The owner sets a password of their own through forgot-password.

  Two first sign-ins racing each other both miss the lookups; the unique index
  on email catches the second create and server.js turns P2002 into a 409.
*/
async function resolveGoogleUser({ sub, email, name }) {
    const linked = await prisma.user.findUnique({ where: { googleSub: sub } });
    if (linked) {
        if (linked.deletedAt) throw googleRejected();
        return linked;
    }

    const existing = await prisma.user.findUnique({ where: { email } });

    if (!existing) {
        const user = await prisma.user.create({
            data: {
                email,
                fullName: googleFullName(name, email),
                googleSub: sub,
                emailVerifiedAt: new Date(),
            },
        });
        log.success(`Registered ${user.email} through Google`);
        return user;
    }

    if (existing.deletedAt) throw googleRejected();

    if (existing.googleSub) {
        throw conflict('That email is already linked to a different Google account');
    }

    if (existing.emailVerifiedAt) {
        const user = await prisma.user.update({
            where: { id: existing.id },
            data: { googleSub: sub },
        });
        log.success(`Linked Google to ${user.email}`);
        return user;
    }

    const now = new Date();
    const [user] = await prisma.$transaction([
        prisma.user.update({
            where: { id: existing.id },
            data: { googleSub: sub, emailVerifiedAt: now, passwordHash: null },
        }),
        revokeAllRefreshTokens(existing.id),
        prisma.emailVerificationToken.updateMany({
            where: { userId: existing.id, usedAt: null },
            data: { usedAt: now },
        }),
    ]);
    log.warn(`Linked Google to unverified ${user.email} - its password was discarded`);
    return user;
}

/*
  The Google equivalent of login(), answering in exactly the same shape.

  An address Google itself has not verified proves nothing about who owns it,
  so it is refused rather than trusted.
*/
async function googleSignIn({ idToken }) {
    const google = await googleVerifier.verify(idToken);
    if (!google.emailVerified) throw googleRejected();

    const user = await resolveGoogleUser(google);

    const { token } = await issueRefreshToken(user.id);
    return authResponse(user, token);
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

// Silent, like resendVerification: this is the endpoint where confirming an
// address would hand an attacker a free membership check on any email.
async function forgotPassword(email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.deletedAt) return;

    const token = generateToken();

    await prisma.$transaction([
        prisma.passwordResetToken.updateMany({
            where: { userId: user.id, usedAt: null },
            data: { usedAt: new Date() },
        }),
        prisma.passwordResetToken.create({
            data: {
                userId: user.id,
                tokenHash: hashToken(token),
                expiresAt: expiresIn(RESET_TTL_MS),
            },
        }),
    ]);

    await deliver(user.email, () =>
        sendPasswordResetEmail({ to: user.email, fullName: user.fullName, token })
    );
}

async function loadUsableResetToken(rawToken) {
    const row = await prisma.passwordResetToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
        include: { user: { select: { id: true, email: true, deletedAt: true } } },
    });

    if (!row || row.usedAt || row.expiresAt <= new Date() || row.user.deletedAt) {
        throw badRequest('This password reset link is invalid or has expired');
    }

    return row;
}

// What the GET link does: says whether the form is worth showing, changes nothing.
async function checkResetToken(rawToken) {
    await loadUsableResetToken(rawToken);
    return { valid: true };
}

/*
  A password change signs out every device. Whoever forced the reset - the owner
  locked out, or an attacker who had the password - the sign-ins made before this
  moment are exactly the ones that must not survive it.
*/
async function resetPassword({ token, password }) {
    const row = await loadUsableResetToken(token);
    const passwordHash = await hashPassword(password);

    await prisma.$transaction([
        prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
        prisma.passwordResetToken.updateMany({
            where: { userId: row.userId, usedAt: null },
            data: { usedAt: new Date() },
        }),
        prisma.refreshToken.updateMany({
            where: { userId: row.userId, revokedAt: null },
            data: { revokedAt: new Date() },
        }),
    ]);

    log.success(`Password reset for ${row.user.email}`);
}

export {
    VERIFICATION_TTL_MS,
    RESET_TTL_MS,
    publicUser,
    buildAuthClaims,
    authResponse,
    issueRefreshToken,
    revokeAllRefreshTokens,
    registerUser,
    verifyEmail,
    resendVerification,
    login,
    refreshAuth,
    logout,
    googleSignIn,
    forgotPassword,
    checkResetToken,
    resetPassword,
};
