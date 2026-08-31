import 'dotenv/config';

import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import { AppError, notFound, ok } from './shared/errors.js';
import { generalLimiter } from './shared/rateLimit.js';
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
  Module routes mount here as they are built: auth · users · school · academics

  Where the per-route limiters go (./shared/rateLimit.js):
    POST /auth/login                     loginLimiter
    school code lookup + join request    joinSchoolLimiter
    POST /school-registrations           registrationLimiter

  The last two key on req.auth.userId, so they MUST be mounted after
  authenticate. Mounted before it, req.auth is still empty when the key is
  computed, the key silently falls back to the IP, and a whole school shares one
  budget again - with no error to tell you.
*/

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
    });
}

export default app;
