'use strict';

const { badRequest } = require('./errors');

/**
 * Zod v4. String formats moved to the top level in v4, so it is z.email(),
 * not z.string().email().
 *
 * Express 5 defines req.query as a getter, so parsed output cannot be written
 * back over req.query / req.params. Validated values land on req.validated
 * instead, and handlers should read from there rather than from the raw request.
 */

const formatIssues = (error) =>
    error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
    }));

function validate(schemas) {
    return (req, _res, next) => {
        req.validated = req.validated ?? {};

        for (const source of ['body', 'params', 'query']) {
            const schema = schemas[source];
            if (!schema) continue;

            const result = schema.safeParse(req[source]);
            if (!result.success) {
                return next(
                    badRequest(`Invalid request ${source}`, formatIssues(result.error))
                );
            }
            req.validated[source] = result.data;
        }

        return next();
    };
}

module.exports = { validate, formatIssues };
