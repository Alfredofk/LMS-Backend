import nodemailer from 'nodemailer';

/*
  Transactional email ONLY: account verification and password reset (ADR-0002).

  Notifications stay in-app and polled. Nothing about grades, attendance, reports
  or guardian alerts is ever emailed - that was settled deliberately, and adding
  it here would route minors' academic data through an external relay.

  With SMTP_HOST unset the transport logs to the console instead of sending, so
  development and tests never need a real mail server.
*/

let cachedTransport = null;

function isConfigured() {
    return Boolean(process.env.SMTP_HOST);
}

function getTransport() {
    if (cachedTransport) return cachedTransport;

    if (!isConfigured()) {
        cachedTransport = {
            sendMail: async (message) => {
                // eslint-disable-next-line no-console
                console.log(
                    '\n--- email (no SMTP_HOST; not sent) ---\n' +
                        `to:      ${message.to}\n` +
                        `subject: ${message.subject}\n` +
                        `${message.text}\n` +
                        '--- end email ---\n'
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

const baseUrl = () => process.env.APP_BASE_URL ?? 'http://localhost:3000';

async function send({ to, subject, text }) {
    return getTransport().sendMail({
        from: process.env.MAIL_FROM ?? 'LMS <no-reply@lms.local>',
        to,
        subject,
        text,
    });
}

async function sendVerificationEmail({ to, fullName, token }) {
    const link = `${baseUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    return send({
        to,
        subject: 'Verify your LMS account',
        text:
            `Hello ${fullName},\n\n` +
            'Confirm this address to activate your account:\n\n' +
            `${link}\n\n` +
            'The link expires in 24 hours. If you did not create this account, ignore this email.\n',
    });
}

async function sendPasswordResetEmail({ to, fullName, token }) {
    const link = `${baseUrl()}/api/auth/reset-password?token=${encodeURIComponent(token)}`;
    return send({
        to,
        subject: 'Reset your LMS password',
        text:
            `Hello ${fullName},\n\n` +
            'Reset your password here:\n\n' +
            `${link}\n\n` +
            'The link expires in 1 hour. If you did not request this, ignore this email ' +
            'and your password stays unchanged.\n',
    });
}

export {
    isConfigured,
    send,
    sendVerificationEmail,
    sendPasswordResetEmail,
};
