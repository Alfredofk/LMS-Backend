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
import { AppError, badRequest, conflict, notFound, unauthorized } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('Auth');

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // matches the wording in mailer.js
const RESET_TTL_MS = 60 * 60 * 1000;

// A bcrypt hash of a value nobody will ever type, compared against when the email
// is unknown.
//
// Without it, a login for a non-existent account returns in microseconds while a
// wrong password costs a deliberate ~300ms of bcrypt - and that gap alone tells
// an attacker which addresses hold accounts. Created as a promise at import time
// and awaited only on the failing path, so nothing blocks at startup.
const dummyHash = hashPassword(crypto.randomBytes(32).toString('hex'));

const expiresIn = (ms) => new Date(Date.now() + ms);

const publicUser = (user) => ({
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    emailVerifiedAt: user.emailVerifiedAt ?? null,
    createdAt: user.createdAt,
});

// Mail never fails, nor holds, the request that triggered it.
//
// The account, the token and the reset request are already committed; refusing
// the whole call because an SMTP relay was briefly unreachable would strand the
// user with an account they cannot reach and no way to ask again. Both paths that
// send mail have a resend, which is the actual remedy.
//
// So the send runs in the background, and the caller does not wait for it
// (frontend note #20, owner 2026-10-12). Awaited, a relay that never answered held
// register for its whole timeout - and a user who refreshed meanwhile found their
// email "already registered" - while resend-verification and forgot-password,
// silent by design, told a registered address from an unknown one by how long
// they took. A send lost to a restart in between has the same remedy, the resend.
function deliver(context, send) {
    send().catch((error) => log.error(`Email delivery failed (${context}):`, error));
}

// ---------------------------------------------------------------------------
// Claims and Places
// ---------------------------------------------------------------------------

// What a person may open (governing-body ticket 01, ADR-0011): an ACTIVE
// membership at a school still active. A person may hold one at several schools,
// and each is a Place a sign-in can be for.
//
// A deactivated school issues no claims, which is the whole mechanism behind
// withdrawing its access (ticket 14): without a schoolId in the token there is no
// ambient scope, so every tenant-owned query throws and requireActiveMembership
// answers 403. The membership row itself is untouched - the school coming back
// should find its people still in it.
const OPENABLE = { status: 'ACTIVE', endedAt: null, school: { deactivatedAt: null } };

const NO_CLAIMS = { membershipId: null, schoolId: null, schoolName: null, roles: [] };

// The join between authentication and tenancy (ADR-0001), and the one place in
// this module that must step outside the tenant scope.
//
// SchoolMembership and MembershipRole are tenant-owned, but this runs at login -
// before any school is known, which is precisely what the lookup is trying to
// find out. Scoped, the extension would throw (prisma.js:88). The same carve-out
// seed.js:129 makes, for the same reason.
async function openableMembershipsOf(userId) {
    return runUnscoped('listing the schools a user may open, before any school scope exists', async () =>
        await prisma.schoolMembership.findMany({
            where: { userId, ...OPENABLE },
            select: {
                id: true,
                schoolId: true,
                school: { select: { name: true } },
                roles: { where: { status: 'ACTIVE' }, select: { role: true } },
            },
            orderBy: { school: { name: 'asc' } },
        })
    );
}

// One entry of the dropdown that moves a person between their schools (K17). The
// subdomain joins it in ticket 02, a Governing Body seat in ticket 03.
const placeView = (membership) => ({
    kind: 'SCHOOL',
    id: membership.schoolId,
    name: membership.school.name,
    roles: membership.roles.map((entry) => entry.role),
});

const placesOf = async (userId) => (await openableMembershipsOf(userId)).map(placeView);

// Which membership a sign-in opens. Asked for a School, it is that School's while
// the person may open it, and none otherwise: a token is for one Place, and never
// falls to another by itself. Asked for none, it is the one School they may open,
// and none when they may open several - they choose (owner, 2026-10-21).
function chosenOf(openable, schoolId) {
    if (schoolId) return openable.find((entry) => entry.schoolId === schoolId) ?? null;
    return openable.length === 1 ? openable[0] : null;
}

// Only an ACTIVE membership with ACTIVE roles produces claims. A PENDING member
// gets a token carrying no school at all, so every tenant-owned query they could
// reach throws rather than returning rows. The Places come back beside the claims,
// read once.
async function buildAuthClaims(userId, schoolId = null) {
    const openable = await openableMembershipsOf(userId);
    const membership = chosenOf(openable, schoolId);

    const claims = membership
        ? {
            membershipId: membership.id,
            schoolId: membership.schoolId,
            schoolName: membership.school.name,
            roles: membership.roles.map((entry) => entry.role),
        }
        : NO_CLAIMS;

    return { claims, places: openable.map(placeView) };
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

// The row's expiry is read back out of the JWT rather than recomputed from the
// remember-me lifetimes in shared/auth.js. One source of truth: change a lifetime
// there and the table follows, with no chance of a row outliving the token it
// stands for.
//
// schoolId is the Place the row is for (governing-body ticket 01), null for none.
async function issueRefreshToken(userId, { rememberMe = false, schoolId = null, expiresAt = null } = {}) {
    const token = signRefreshToken({ userId, rememberMe, expiresAt });
    const { exp } = verifyRefreshToken(token);

    const row = await prisma.refreshToken.create({
        data: {
            userId,
            schoolId,
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

// One sign-in: an access token for its Place, a refresh token bound to the same
// Place, and every Place the person may open (K17). Returns the answer for the
// client, and the new refresh token's row id for a rotation to point at.
//
// The Place asked for stays the row's even when it no longer opens - a member
// removed from it gets a token with no school, as before, and moves through
// choosePlace. Asked for none, the row is bound to the School it opened, if any:
// an applicant approved since, or a row issued before the ticket, from then on
// refreshes into that School alone.
//
// rememberMe must be the same choice the refresh token was signed with.
async function signIn(user, { rememberMe = false, schoolId = null, expiresAt = null } = {}) {
    const { claims, places } = await buildAuthClaims(user.id, schoolId);
    const issued = await issueRefreshToken(user.id, {
        rememberMe,
        schoolId: schoolId ?? claims.schoolId,
        expiresAt,
    });

    return {
        tokenId: issued.id,
        answer: {
            accessToken: signAccessToken({ userId: user.id, ...claims, rememberMe }),
            refreshToken: issued.token,
            user: publicUser(user),
            membership: claims.membershipId
                ? {
                    id: claims.membershipId,
                    schoolId: claims.schoolId,
                    schoolName: claims.schoolName,
                    roles: claims.roles,
                }
                : null,
            places,
        },
    };
}

// ---------------------------------------------------------------------------
// Registration and verification
// ---------------------------------------------------------------------------

// A taken email answers 409 rather than a vague success.
//
// That does confirm the address has an account, and it is a deliberate, narrow
// trade: a signup form has to be able to say "this email is already registered"
// or people cannot sign up at all. The endpoints where enumeration actually costs
// something - forgot-password and resend-verification - stay silent.
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

// Issuing a new link retires every outstanding one. "Single-use" has to mean the
// newest link is the only one that works, or a forwarded old email stays live.
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

    deliver(user.email, () =>
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

async function login({ email, password, rememberMe }) {
    const user = await prisma.user.findUnique({ where: { email } });
    // No passwordHash means an account made through Google that has not set a
    // password yet. It fails exactly like an unknown address, dummy hash and all.
    const usable = user && !user.deletedAt && user.passwordHash;

    const matches = await verifyPassword(password, usable ? user.passwordHash : await dummyHash);

    if (!usable || !matches) throw unauthorized('Email or password is incorrect');

    // A distinct code, not the generic 401. This does reveal that the account
    // exists - but only to someone who has just proved they know its password,
    // who therefore learns nothing new. The client needs to tell the two apart to
    // offer "resend the verification email" instead of "wrong password".
    if (!user.emailVerifiedAt) {
        throw new AppError(
            403,
            'EMAIL_NOT_VERIFIED',
            'Verify your email address before signing in'
        );
    }

    // No Place asked for: the one School they may open, none with several
    // (governing-body ticket 01). Ticket 02 names it by the subdomain.
    return (await signIn(user, { rememberMe })).answer;
}

// A refresh token presented for rotation: signed, on file, never used, not
// expired, and its account still able to sign in. The remember-me choice comes
// back from its signed payload, never from the request.
//
// A rotated token coming back is the signature of theft: either the legitimate
// holder replayed it or someone copied it - and there is no way to tell which.
// Signing that user out everywhere is the only safe answer, and costs the honest
// user one login. The same holds for a move to another Place (choosePlace), which
// spends the token as a refresh does.
//
// Only a rotated one (replacedByTokenId): a token revoked by a sign-out, a password
// change, an account's deletion or its school's deactivation is simply over, and is
// refused alone (governing-body ticket 01, 2026-10-21). Deactivating SMP A revokes
// the sign-ins for SMP A only; the laptop still holding one presents it at its
// next refresh, and cutting the person's sign-ins at their other schools for that
// would undo the "only".
async function loadLiveRefreshToken(rawToken) {
    const rejected = unauthorized('Invalid or expired refresh token');

    let payload;
    try {
        payload = verifyRefreshToken(rawToken);
    } catch {
        throw rejected;
    }

    const row = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashToken(rawToken) },
    });

    if (!row) throw rejected;

    if (row.revokedAt) {
        if (row.replacedByTokenId) {
            await revokeAllRefreshTokens(row.userId);
            log.warn(`Refresh token reuse for user ${row.userId} - signed out everywhere`);
        }
        throw rejected;
    }

    if (row.expiresAt <= new Date()) throw rejected;

    const user = await prisma.user.findUnique({ where: { id: row.userId } });
    if (!user || user.deletedAt || !user.emailVerifiedAt) throw rejected;

    return { row, user, rememberMe: payload.rem === true };
}

// The presented row, revoked and pointing at the one that replaced it.
const retireRefreshToken = (row, replacedByTokenId) =>
    prisma.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date(), replacedByTokenId },
    });

// Rotation. Every refresh mints a new token and revokes the one presented, so a
// refresh token is good exactly once - which is what makes theft detectable
// (loadLiveRefreshToken).
//
// "Session" is not the word for this anywhere in the codebase: CONTEXT.md gives it
// to one meeting of a ClassSubject. A sign-in belongs to a device.
//
// The remember-me choice is inherited from the token presented, and the new token
// gets that choice's full lifetime again. A token minted before `rem` existed
// carries none, and is treated as not remembered.
//
// Claims are rebuilt here, not carried over, for the Place the row is bound to
// (governing-body ticket 01). This is the moment an approval granted since the
// last login actually reaches the user's token.
async function refreshAuth(rawToken) {
    const { row, user, rememberMe } = await loadLiveRefreshToken(rawToken);

    const { tokenId, answer } = await signIn(user, { rememberMe, schoolId: row.schoolId });
    await retireRefreshToken(row, tokenId);

    return answer;
}

// Moving a sign-in to another of the person's Schools, within one origin
// (governing-body ticket 01, owner 2026-10-21; ticket 02 adds the move across
// subdomains). The refresh token presented is rotated as a refresh rotates it,
// bound to the School asked for, and ends when it would have: the move renews
// nothing. A School they may not open - another's, one they left, one switched
// off, an unknown id - is one 404, answered before the token is spent.
async function choosePlace({ refreshToken, schoolId }) {
    const { row, user, rememberMe } = await loadLiveRefreshToken(refreshToken);

    const { claims } = await buildAuthClaims(user.id, schoolId);
    if (!claims.schoolId) throw notFound('School not found');

    const { tokenId, answer } = await signIn(user, { rememberMe, schoolId, expiresAt: row.expiresAt });
    await retireRefreshToken(row, tokenId);

    log.info(`A sign-in moved to ${claims.schoolName}`);
    return answer;
}

// Idempotent. Logging out twice, or with a token we never issued, is not a
// condition worth reporting - the caller's intent is satisfied either way, and a
// 404 here would confirm which tokens are real.
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

// Which User a verified Google identity signs in as.
//
// The link is googleSub, never the email: a Google account can change its
// address, and its sub never changes. The email is only consulted the first
// time, to find the account this Google identity should attach to.
//
// Three outcomes the first time:
//   - no account for the address  -> one is created, already verified
//   - a verified account          -> linked, its password untouched
//   - an UNVERIFIED account       -> linked, and its password discarded
//
// The last is the one that matters. Anyone can register an address they do not
// own; it just stays unverified. If the real owner later arrives through Google,
// that account becomes verified - and without this, the stranger's password
// would now open it. So the password goes, every refresh token issued against
// it goes, and any verification link still sitting in the inbox is retired.
// The owner sets a password of their own through forgot-password.
//
// Two first sign-ins racing each other both miss the lookups; the unique index
// on email catches the second create and server.js turns P2002 into a 409.
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

// The Google equivalent of login(), answering in exactly the same shape.
//
// An address Google itself has not verified proves nothing about who owns it,
// so it is refused rather than trusted.
async function googleSignIn({ idToken, rememberMe }) {
    const google = await googleVerifier.verify(idToken);
    if (!google.emailVerified) throw googleRejected();

    const user = await resolveGoogleUser(google);

    return (await signIn(user, { rememberMe })).answer;
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

    deliver(user.email, () =>
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

// A password change signs out every device. Whoever forced the reset - the owner
// locked out, or an attacker who had the password - the sign-ins made before this
// moment are exactly the ones that must not survive it.
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
    placesOf,
    signIn,
    issueRefreshToken,
    revokeAllRefreshTokens,
    registerUser,
    verifyEmail,
    resendVerification,
    login,
    refreshAuth,
    choosePlace,
    logout,
    googleSignIn,
    forgotPassword,
    checkResetToken,
    resetPassword,
};
