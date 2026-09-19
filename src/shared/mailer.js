import nodemailer from 'nodemailer';

import { createLogger } from '../lib/helpers.js';

/*
  Transactional email ONLY: account verification and password reset (ADR-0002).

  Notifications stay in-app and polled. Nothing about grades, attendance, reports
  or guardian alerts is ever emailed - that was settled deliberately, and adding
  it here would route minors' academic data through an external relay.

  With SMTP_HOST unset the transport logs to the console instead of sending, so
  development and tests never need a real mail server.
*/

const log = createLogger('Mail');

let cachedTransport = null;

function isConfigured() {
    return Boolean(process.env.SMTP_HOST);
}

function getTransport() {
    if (cachedTransport) return cachedTransport;

    if (!isConfigured()) {
        cachedTransport = {
            sendMail: async (message) => {
                log.warn(
                    `No SMTP_HOST - email to ${message.to} was NOT sent. ` +
                        `Subject: ${message.subject}\n${message.text}`
                );
                return { messageId: 'console', accepted: [message.to] };
            },
        };
        return cachedTransport;
    }

    cachedTransport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
            : undefined,
    });
    return cachedTransport;
}

/*
  Called once at startup (server.js) so the log says plainly which of the two
  transports is live.

  It exists because every send sits behind deliver() in auth.service.js, which
  swallows failures on purpose - a dead relay must not fail a registration that
  is already committed. Without this check a misconfigured relay is completely
  silent: the account is created, the response is 201, and the email simply
  never arrives. Never throws; a server that cannot mail must still come up,
  because resend is the remedy and it needs the server running.
*/
async function verifyTransport() {
    if (!isConfigured()) {
        log.warn('SMTP_HOST is not set - verification and reset emails will only be logged here');
        return false;
    }

    try {
        await getTransport().verify();
        log.success(`SMTP ready: ${process.env.SMTP_HOST} as ${process.env.SMTP_USER ?? 'anonymous'}`);
        return true;
    } catch (error) {
        log.error('SMTP verify failed - no email will be delivered until this is fixed:', error);
        return false;
    }
}

const webUrl = () => process.env.WEB_BASE_URL ?? 'http://localhost:5173';

/*
  MAIL_FROM falls back to the authenticated account rather than to a made-up
  local address. Gmail and most relays reject - or silently rewrite - a From
  that is neither the account nor one of its verified aliases, and the rejection
  surfaces only in the log line below.
*/
const mailFrom = () => process.env.MAIL_FROM || process.env.SMTP_USER || 'LMS <no-reply@lms.local>';

/*
  Five characters, and that is enough: everything interpolated below is either a
  name this system stores or a URL it built itself. No recipient-supplied markup
  reaches these templates.
*/
const escapeHtml = (value) =>
    String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

/*
  One layout for both emails: a title, a greeting, one sentence, one labelled
  button and a caveat.

  The label is the point - the reader sees "Verify my account" instead of sixty
  characters of hex, and the URL appears nowhere in the HTML. That is the owner's
  call: no "button not working, copy this address" line under it.

  So the plain-text alternative below is the only copy of the URL left, and it
  has to stay one: it is all a text-only client can follow, it is what the
  console transport prints, and it is where the probes read the token back out.
  A recipient whose client strips the button can still reach the link there.

  Every style is inline and the markup is divs and one table for the button.
  Mail clients drop <style> blocks, ignore flexbox, and Outlook renders a
  padded <a> inconsistently - a single-cell table is the one button that lands
  the same way everywhere.
*/
function layout({ title, fullName, intro, action, link, caveat }) {
    const safeLink = escapeHtml(link);

    return (
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
        '<body style="margin:0;padding:32px 16px;background:#f2f4f7;' +
        'font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
        'color:#1f2328;-webkit-font-smoothing:antialiased">' +
        '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;' +
        'padding:40px 36px;box-shadow:0 1px 3px rgba(16,24,40,.08)">' +
        `<h1 style="margin:0 0 24px;font-size:24px;line-height:1.3;font-weight:700;color:#0d1117">${escapeHtml(title)}</h1>` +
        `<p style="margin:0 0 16px;font-size:17px;line-height:1.6"><strong>Hello ${escapeHtml(fullName)},</strong></p>` +
        `<p style="margin:0 0 32px;font-size:17px;line-height:1.6;color:#39414a">${escapeHtml(intro)}</p>` +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 32px">' +
        `<tr><td style="border-radius:8px;background:#1f6feb"><a href="${safeLink}" ` +
        'style="display:inline-block;padding:14px 28px;font-size:17px;font-weight:600;' +
        `color:#ffffff;text-decoration:none">${escapeHtml(action)}</a></td></tr></table>` +
        '<hr style="border:none;border-top:1px solid #e6e9ee;margin:0 0 20px">' +
        `<p style="margin:0;font-size:13px;line-height:1.6;color:#6b7580">${escapeHtml(caveat)}</p>` +
        '</div></body></html>'
    );
}

async function send({ to, subject, text, html }) {
    const info = await getTransport().sendMail({ from: mailFrom(), to, subject, text, html });

    // The receipt. deliver() in auth.service.js hides failures, so a send that
    // leaves no trace at all is indistinguishable from one that never happened.
    log.success(`Sent "${subject}" to ${(info.accepted ?? [to]).join(', ')} (${info.messageId})`);

    return info;
}

async function sendVerificationEmail({ to, fullName, token }) {
    const link = `${webUrl()}/verify-email?token=${encodeURIComponent(token)}`;
    const caveat =
        'The link expires in 24 hours. If you did not create this account, ignore this email.';

    return send({
        to,
        subject: 'Verify your LMS account',
        text:
            `Hello ${fullName},\n\n` +
            'Confirm this address to activate your account:\n\n' +
            `${link}\n\n` +
            `${caveat}\n`,
        html: layout({
            title: 'Verify your LMS account',
            fullName,
            intro: 'Confirm this address to activate your account, then sign in.',
            action: 'Verify my account',
            link,
            caveat,
        }),
    });
}

async function sendPasswordResetEmail({ to, fullName, token }) {
    const link = `${webUrl()}/reset-password?token=${encodeURIComponent(token)}`;
    const caveat =
        'The link expires in 1 hour. If you did not request this, ignore this email ' +
        'and your password stays unchanged.';

    return send({
        to,
        subject: 'Reset your LMS password',
        text:
            `Hello ${fullName},\n\n` +
            'Reset your password here:\n\n' +
            `${link}\n\n` +
            `${caveat}\n`,
        html: layout({
            title: 'Reset your LMS password',
            fullName,
            intro: 'Choose a new password to get back into your account.',
            action: 'Reset my password',
            link,
            caveat,
        }),
    });
}

export {
    isConfigured,
    verifyTransport,
    send,
    sendVerificationEmail,
    sendPasswordResetEmail,
};
