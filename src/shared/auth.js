import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

import { unauthorized, forbidden } from './errors.js';
import { runInSchool } from './tenantContext.js';

/*
  Authorization here is resource-scoped, not role-string-based.

  "Is this teacher assigned to this ClassSubject?" is the question that actually
  protects a student's grades. requireRole() below is a coarse pre-filter only -
  it narrows who may reach a handler, and never decides who may touch a row.
  The resource guards live in ./guards.js, which needs the Prisma schema.
*/

const BCRYPT_ROUNDS = 12;

/*
  How long one sign-in lives, chosen by "remember me" at login and never by the
  client afterwards. The choice rides inside the signed refresh token as `rem`,
  so it survives every rotation and cannot be edited without breaking the
  signature. Each rotation mints a fresh token with the full lifetime again, so
  these are periods of inactivity, not absolute caps.
*/
const REFRESH_TTL_REMEMBERED = '14d';
const REFRESH_TTL_DEFAULT = '1d';

function secret(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is not set. Add ${name} to .env and fill it in.`);
    }
    return value;
}

const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

/*
  Verification and password-reset tokens are handed out in the clear once and
  stored only as a hash, so a leaked database does not hand over live tokens.
  SHA-256 is right here rather than bcrypt: these are high-entropy random values,
  not guessable secrets, and they are checked on every click.
*/
const generateToken = () => crypto.randomBytes(32).toString('hex');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function signAccessToken({ userId, membershipId, schoolId, schoolName, roles, rememberMe }) {
    return jwt.sign(
        {
            sub: userId,
            membershipId: membershipId ?? null,
            schoolId: schoolId ?? null,
            // Carried so the logger can name the school's folder without a lookup.
            schoolName: schoolName ?? null,
            roles: roles ?? [],
            // Read by change-password, which re-issues this device's refresh token
            // holding only the access token, and must keep the device's choice.
            rem: rememberMe === true,
        },
        secret('JWT_ACCESS_SECRET'),
        { expiresIn: process.env.JWT_ACCESS_TTL ?? '15m' }
    );
}

/*
  The jti is not decoration. Without it the payload is just { sub, iat, exp },
  so two refresh tokens minted for the same user inside the same second are
  byte-identical - identical signature, identical hash - and the unique index on
  RefreshToken.tokenHash rejects the second one. Signing in on a phone and a
  laptop at the same moment is enough to hit it.
*/
function signRefreshToken({ userId, rememberMe }) {
    const rem = rememberMe === true;
    return jwt.sign({ sub: userId, jti: crypto.randomUUID(), rem }, secret('JWT_REFRESH_SECRET'), {
        expiresIn: rem ? REFRESH_TTL_REMEMBERED : REFRESH_TTL_DEFAULT,
    });
}

function verifyAccessToken(token) {
    return jwt.verify(token, secret('JWT_ACCESS_SECRET'));
}

function verifyRefreshToken(token) {
    return jwt.verify(token, secret('JWT_REFRESH_SECRET'));
}

function readBearer(req) {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice('Bearer '.length).trim() || null;
}

/*
  Authenticate, then open the tenant scope for the rest of the request.

  A user with no active membership runs with no ambient school, so any
  tenant-owned query they trigger throws instead of returning another school's
  rows. That is the intended failure mode (ADR-0001).
*/
function requireAuth(req, res, next) {
    const token = readBearer(req);
    if (!token) return next(unauthorized());

    let payload;
    try {
        payload = verifyAccessToken(token);
    } catch (error) {
        const message =
            error.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token';
        return next(unauthorized(message));
    }

    req.auth = {
        userId: payload.sub,
        membershipId: payload.membershipId ?? null,
        schoolId: payload.schoolId ?? null,
        schoolName: payload.schoolName ?? null,
        roles: payload.roles ?? [],
        rememberMe: payload.rem === true,
    };

    // No school scope means no school folder either - those logs go to server/.
    if (!req.auth.schoolId) return next();
    return runInSchool(req.auth.schoolId, req.auth.schoolName, () => next());
}

// Coarse pre-filter. Never the last word on access to a specific row.
function requireRole(...allowed) {
    return (req, _res, next) => {
        if (!req.auth) return next(unauthorized());
        const held = req.auth.roles ?? [];
        if (!allowed.some((role) => held.includes(role))) {
            return next(forbidden());
        }
        return next();
    };
}

function requireActiveMembership(req, _res, next) {
    if (!req.auth) return next(unauthorized());
    if (!req.auth.membershipId || !req.auth.schoolId) {
        return next(forbidden('You are not an active member of any school'));
    }
    return next();
}

export {
    BCRYPT_ROUNDS,
    REFRESH_TTL_REMEMBERED,
    REFRESH_TTL_DEFAULT,
    hashPassword,
    verifyPassword,
    generateToken,
    hashToken,
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    requireAuth,
    requireRole,
    requireActiveMembership,
};
