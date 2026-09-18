import { z } from 'zod';

/*
  Zod v4: string formats live at the top level, so it is z.email() and not
  z.string().email() (validate.js:4-6).
*/

/*
  bcrypt hashes at most 72 BYTES and silently discards the rest - a 100-character
  passphrase would authenticate on its first 72 bytes alone, and nothing anywhere
  would report it. The cap is on bytes rather than characters because a password
  written in Indonesian may well carry multi-byte characters.
*/
const MIN_PASSWORD = 8;
const MAX_PASSWORD_BYTES = 72;

/*
  All four character classes are required, not three of four. The rule is the
  owner's, and it is the one a thesis can state in a sentence.

  A symbol is anything that is not a letter, not a digit and not whitespace.
  Excluding whitespace is the point: otherwise a trailing space - invisible, and
  usually a typo rather than a choice - would satisfy the rule on its own.

  Zod runs every string check and collects all of them, so a password missing
  three of the classes is told all three at once instead of one per round-trip.
*/
const password = z
    .string()
    .min(MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters`)
    .regex(/[A-Z]/, 'Password must contain an uppercase letter')
    .regex(/[a-z]/, 'Password must contain a lowercase letter')
    .regex(/[0-9]/, 'Password must contain a number')
    .regex(/[^A-Za-z0-9\s]/, 'Password must contain a symbol')
    .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES,
        `Password must be at most ${MAX_PASSWORD_BYTES} bytes`
    );

// Stored and compared lowercase, so Budi@x.id and budi@X.id are one account.
const email = z
    .email('Enter a valid email address')
    .max(254)
    .transform((value) => value.trim().toLowerCase());

const fullName = z
    .string()
    .trim()
    .min(2, 'Full name is too short')
    .max(120, 'Full name is too long');

// The link in the email carries it as a query string (mailer.js:63).
const tokenQuery = z.object({
    token: z.string().min(1, 'Missing token'),
});

const registerBody = z.object({ email, password, fullName });

const loginBody = z.object({
    email,
    // Never validated for shape on login: an old password that predates a rule
    // change must still be able to authenticate and then be changed.
    password: z.string().min(1, 'Password is required'),
});

const emailOnlyBody = z.object({ email });

const refreshBody = z.object({
    refreshToken: z.string().min(1, 'Missing refresh token'),
});

const resetPasswordBody = z.object({
    token: z.string().min(1, 'Missing token'),
    password,
});

export {
    MIN_PASSWORD,
    MAX_PASSWORD_BYTES,
    password,
    email,
    fullName,
    tokenQuery,
    registerBody,
    loginBody,
    emailOnlyBody,
    refreshBody,
    resetPasswordBody,
};
