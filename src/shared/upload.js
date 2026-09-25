import multer from 'multer';

import { badRequest } from './errors.js';

// Multipart uploads, held in memory until a service decides where they go
// (StorageService, ./storage.js). Nothing touches the disk here, so a request
// that fails validation leaves no file behind to clean up.
//
// The type is read from the file's first bytes, never from its name or its
// Content-Type header. Both of those are whatever the client says they are, and
// "ktp.png" can hold anything.

// "%PDF-" opens every PDF (ticket 17: a resignation letter is often a scan saved
// as one).
const SIGNATURES = {
    jpg: [0xff, 0xd8, 0xff],
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pdf: [0x25, 0x50, 0x44, 0x46, 0x2d],
};

const MIME = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

function detectType(buffer) {
    for (const [type, bytes] of Object.entries(SIGNATURES)) {
        if (buffer.length >= bytes.length && bytes.every((byte, i) => buffer[i] === byte)) {
            return type;
        }
    }
    return null;
}

// One required file under `field`, at most `maxBytes`, of one of `types`.
//
// On success req.file carries `detectedType` ('jpg' | 'png' | 'pdf'). Multer's own
// errors - too large, too many files, an unexpected field - become a 400 in the
// usual envelope instead of falling through to the 500 handler.
function singleFile(field, { maxBytes, types }) {
    const parse = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxBytes, files: 1 },
    }).single(field);

    const allowed = types.join(', ').toUpperCase();

    return (req, res, next) => {
        parse(req, res, (error) => {
            if (error instanceof multer.MulterError) {
                const message =
                    error.code === 'LIMIT_FILE_SIZE'
                        ? `The ${field} file must be at most ${maxBytes / (1024 * 1024)} MB`
                        : `Invalid upload: ${error.message}`;
                return next(badRequest(message, { field: error.field ?? field }));
            }
            if (error) return next(error);

            if (!req.file) {
                return next(badRequest(`The ${field} file is required`, { field }));
            }

            const detected = detectType(req.file.buffer);
            if (!detected || !types.includes(detected)) {
                return next(badRequest(`The ${field} file must be one of: ${allowed}`, { field }));
            }

            req.file.detectedType = detected;
            return next();
        });
    };
}

export { singleFile, detectType, MIME };
