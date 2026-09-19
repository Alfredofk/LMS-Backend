import { OAuth2Client } from 'google-auth-library';

import { unauthorized } from './errors.js';
import { createLogger } from '../lib/helpers.js';

const log = createLogger('Google');

/*
  Google sign-in, the ID token flow (ADR-0005).

  The browser runs Google Identity Services and hands us the ID token it
  received. verifyIdToken() checks Google's signature against its published
  keys, the expiry, the issuer and - the one that matters most - the audience:
  a token Google minted for somebody else's app must not sign anyone in here.

  No client secret is involved. This flow never exchanges a code for tokens, so
  GOOGLE_CLIENT_ID is the only setting it needs.
*/
const client = new OAuth2Client();

function clientId() {
    const value = process.env.GOOGLE_CLIENT_ID;
    if (!value) {
        throw new Error('GOOGLE_CLIENT_ID is not set. Add GOOGLE_CLIENT_ID to .env and fill it in.');
    }
    return value;
}

/*
  Every way a token can be wrong answers the same 401. Which check failed is
  worth a log line for us, not a hint for whoever presented it.

  The missing-client-id error is read before the try on purpose: a server that
  is misconfigured should answer 500 and say why in the log, not blame the user.
*/
async function verify(idToken) {
    const audience = clientId();

    let payload;
    try {
        const ticket = await client.verifyIdToken({ idToken, audience });
        payload = ticket.getPayload();
    } catch (error) {
        log.warn(`Rejected a Google ID token: ${error.message}`);
        throw unauthorized('Google sign-in failed');
    }

    if (!payload?.sub || !payload.email) throw unauthorized('Google sign-in failed');

    return {
        sub: payload.sub,
        email: payload.email.trim().toLowerCase(),
        emailVerified: payload.email_verified === true,
        name: payload.name ?? null,
    };
}

/*
  An object rather than a bare function so a probe can swap verify() for a fake
  and drive every branch of the sign-in without a real Google account. ESM
  exports are read-only bindings; a property on an exported object is not.
*/
const googleVerifier = { verify };

export { googleVerifier };
