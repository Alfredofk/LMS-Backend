'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Rate limiting is one of the four things that make the School Code model
 * defensible (ADR-0002). It does not stand alone - the human approval gate is
 * the real control - but it raises the cost of guessing codes or bulk-creating
 * accounts enough that the gate is never facing a flood.
 */

const envelope = (message) => ({
    success: false,
    data: null,
    error: { code: 'TOO_MANY_REQUESTS', message },
});

const build = ({ windowMs, limit, message }) =>
    rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: envelope(message),
    });

/** Login, register, password reset: cheap to attempt, expensive to get wrong. */
const authLimiter = build({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: 'Too many authentication attempts. Try again in a few minutes.',
});

/** School Code lookup and join requests - the guessing surface. */
const joinLimiter = build({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    message: 'Too many join attempts. Try again later.',
});

/** School registration: a human reviews each one, so the ceiling is low. */
const registrationLimiter = build({
    windowMs: 24 * 60 * 60 * 1000,
    limit: 5,
    message: 'Too many school registration submissions from this address today.',
});

const generalLimiter = build({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    message: 'Too many requests.',
});

module.exports = {
    authLimiter,
    joinLimiter,
    registrationLimiter,
    generalLimiter,
};
