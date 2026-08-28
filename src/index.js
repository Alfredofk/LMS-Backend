'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const { AppError, notFound, ok } = require('./shared/errors');
const { generalLimiter } = require('./shared/rateLimit');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(generalLimiter);

app.get('/health', (_req, res) =>
    ok(res, { status: 'up', timestamp: new Date().toISOString() })
);

// Module routes mount here as they are built:
//   auth · users · school · academics

app.use((_req, _res, next) => next(notFound('Route not found')));

// eslint-disable-next-line no-unused-vars
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

    // Unique-constraint violations surface as conflicts rather than 500s.
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

    // P2025 is Prisma's "record not found". Under tenant isolation that is also
    // what a cross-school read looks like, so it must stay a 404 (ADR-0001).
    if (error?.code === 'P2025') {
        return res.status(404).json({
            success: false,
            data: null,
            error: { code: 'NOT_FOUND', message: 'Not found' },
        });
    }

    // eslint-disable-next-line no-console
    console.error(error);
    return res.status(500).json({
        success: false,
        data: null,
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Listening on http://localhost:${port}`);
    });
}

module.exports = app;
