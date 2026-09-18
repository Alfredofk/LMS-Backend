import { Router } from 'express';

import { validate } from '../../shared/validate.js';
import { loginLimiter, emailDispatchLimiter } from '../../shared/rateLimit.js';
import * as controller from './auth.controller.js';
import {
    registerBody,
    loginBody,
    emailOnlyBody,
    refreshBody,
    resetPasswordBody,
    tokenQuery,
} from './auth.schema.js';

/*
  Every route here is unauthenticated - these are the endpoints a person reaches
  before they have a token, so none of them can lean on the per-user budget in
  generalLimiter. Two threats earn a limiter of their own, and only two.

  loginLimiter guards password guessing, per account. emailDispatchLimiter
  rations our mail relay on the two endpoints that send an email on demand.
  Both key partly on req.body.email, so both must sit after express.json()
  (server.js). They do: this router is mounted well below it.

  Everything else here - register, and the three link-click paths - is covered by
  generalLimiter alone, which is where the reasoning for that lives. The short
  version: a 256-bit token is not guessable, a real link only arrives by an
  email emailDispatchLimiter already counted, and an address can be registered
  exactly once.

  The two GET paths are not free choices of shape. mailer.js already writes
  these exact URLs into the emails we send, query string and all.
*/
const router = Router();

router.post('/register', validate({ body: registerBody }), controller.register);

router.get('/verify-email', validate({ query: tokenQuery }), controller.verifyEmail);

router.post(
    '/resend-verification',
    emailDispatchLimiter,
    validate({ body: emailOnlyBody }),
    controller.resendVerification
);

router.post('/login', loginLimiter, validate({ body: loginBody }), controller.login);

// Rotation is its own ceiling: a refresh token is good exactly once, so
// replaying one cannot be repeated for profit and needs no separate limiter.
router.post('/refresh', validate({ body: refreshBody }), controller.refresh);

router.post('/logout', validate({ body: refreshBody }), controller.logout);

router.post(
    '/forgot-password',
    emailDispatchLimiter,
    validate({ body: emailOnlyBody }),
    controller.forgotPassword
);

router.get('/reset-password', validate({ query: tokenQuery }), controller.checkResetToken);

router.post('/reset-password', validate({ body: resetPasswordBody }), controller.resetPassword);

export default router;
