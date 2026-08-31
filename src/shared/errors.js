class AppError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
        this.details = details;
        this.expected = true;
    }
}

const badRequest = (message, details) =>
    new AppError(400, 'BAD_REQUEST', message, details);

const unauthorized = (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHORIZED', message);

const forbidden = (message = 'You do not have access to this resource') =>
    new AppError(403, 'FORBIDDEN', message);

const conflict = (message, details) =>
    new AppError(409, 'CONFLICT', message, details);

const tooManyRequests = (message = 'Too many requests') =>
    new AppError(429, 'TOO_MANY_REQUESTS', message);

const notFound = (message = 'Not found') =>
    new AppError(404, 'NOT_FOUND', message);

const ok = (res, data, status = 200) =>
    res.status(status).json({ success: true, data, error: null });

export {
    AppError,
    badRequest,
    unauthorized,
    forbidden,
    notFound,
    conflict,
    tooManyRequests,
    ok,
};
