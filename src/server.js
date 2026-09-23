import 'dotenv/config';

import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import { AppError, notFound, ok } from './shared/errors.js';
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import schoolRegistrationRoutes, {
    adminRouter as adminSchoolRegistrationRoutes,
    memberRouter as schoolRoutes,
} from './modules/school/school.routes.js';
import membershipRoutes, {
    reviewRouter as membershipReviewRoutes,
} from './modules/membership/membership.routes.js';
import { generalLimiter } from './shared/rateLimit.js';
import { verifyTransport } from './shared/mailer.js';
import { createLogger } from './lib/helpers.js';

const log = createLogger('Server');
const app = express();
const port = process.env.PORT || 3000;

app.disable('x-powered-by');
/*
  Harus sama persis dengan jumlah reverse proxy di depan app (0 = langsung).

  Kalau kebesaran, req.ip jadi alamat proxy dan SEMUA user berbagi satu counter
  rate limit. Kalau kekecilan, klien bisa mengarang X-Forwarded-For sendiri dan
  limitnya bypass total. Tidak ada warning untuk nilai yang salah - makanya ini
  dari env, bukan di-hardcode.
*/
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 0));

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(generalLimiter);

app.get('/health', (_req, res) =>
    ok(res, { status: 'up', timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }) })
);

/*
  Module routes. Still to come: academics (ticket 07).

  The /api prefix is not a free choice - the web app's dev server proxies
  exactly /api to this process (LMS-Frontend vite.config.js), and its
  authService.js builds every call on it. Emails no longer link here: mailer.js
  points them at the web app's own pages, which then call these routes.

  Where the per-route limiters go (./shared/rateLimit.js):
    POST /api/auth/login                 loginLimiter         (mounted)
    resend-verification + forgot         emailDispatchLimiter (mounted)
    lookup + join request                joinSchoolLimiter    (mounted)
    POST /api/school-registrations       registrationLimiter  (mounted)

  joinSchoolLimiter and registrationLimiter key on req.auth.userId, so they MUST
  be mounted after requireAuth. Mounted before it, req.auth is still empty when
  the key is computed, the key silently falls back to the IP, and a whole school
  shares one budget again - with no error to tell you.

  The auth routes above are the exception, and deliberately so: they run before
  anyone has a token, so their limiters key on the address or the network.

  Register and the two link-click endpoints are on no list at all, on purpose.
  They used to carry a signupLimiter and a tokenClaimLimiter; both were removed
  because neither was guarding a real threat, so generalLimiter above is their
  whole ceiling now. The reasoning sits with generalLimiter itself.
*/
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/school-registrations', schoolRegistrationRoutes);
app.use('/api/admin/school-registrations', adminSchoolRegistrationRoutes);
app.use('/api/school', schoolRoutes);
app.use('/api/memberships', membershipRoutes);
app.use('/api/membership-requests', membershipReviewRoutes);

// Catch 404
app.use((_req, _res, next) => next(notFound('Route not found')));

// Error handler
app.use((error, _req, res, _next) => {
    if (error instanceof AppError) {
        return res.status(error.status).json({
            success: false,
            data: null,
            error: {
                code: error.code,
                message: error.message,
                ...(error.details ? { details: error.details } : {}),
            },
        });
    }

    // Unique Constraint Error
    if (error?.code === 'P2002') {
        return res.status(409).json({
            success: false,
            data: null,
            error: {
                code: 'CONFLICT',
                message: 'That value is already taken',
                details: { target: error.meta?.target ?? null },
            },
        });
    }

    // Record Not Found (Jika user mencoba untuk akses data di sekolah lain yang tidak dimiliki di sekolahnya)
    if (error?.code === 'P2025') {
        return res.status(404).json({
            success: false,
            data: null,
            error: { code: 'NOT_FOUND', message: 'Not found' },
        });
    }

    // Log Error
    log.error(error);
    return res.status(500).json({
        success: false,
        data: null,
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    app.listen(port, () => {
        log.success(`Listening on PORT: ${port}`);

        /*
          Fire and forget: the answer is a log line, not a gate. Mail failing is
          never a reason to refuse to serve - resend-verification is the remedy
          and it needs this process up (auth.service.js:44-51).
        */
        void verifyTransport();
    });
}

export default app;
