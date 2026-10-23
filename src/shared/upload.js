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

const MIME = {
    jpg: 'image/jpeg',
    png: 'image/png',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// DOCX and PPTX (teaching-and-learning 04) are ZIP packages, Office Open XML:
// "PK\3\4", then parts by name. A ZIP stores its file names uncompressed, so the
// part that says what the package is can be found in the bytes without unpacking.
// A plain ZIP is neither, and one carrying macros (vbaProject.bin, a .docm or
// .pptm renamed) is refused: these files are opened on children's devices.
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OOXML_PARTS = { docx: 'word/document.xml', pptx: 'ppt/presentation.xml' };

const startsWith = (buffer, bytes) => buffer.length >= bytes.length && bytes.every((byte, i) => buffer[i] === byte);

function detectOoxml(buffer) {
    if (!buffer.includes('[Content_Types].xml') || buffer.includes('vbaProject.bin')) return null;
    for (const [type, part] of Object.entries(OOXML_PARTS)) {
        if (buffer.includes(part)) return type;
    }
    return null;
}

function detectType(buffer) {
    for (const [type, bytes] of Object.entries(SIGNATURES)) {
        if (startsWith(buffer, bytes)) return type;
    }
    if (startsWith(buffer, ZIP)) return detectOoxml(buffer);
    return null;
}

// One required file under `field`, at most `maxBytes`, of one of `types`.
//
// On success req.file carries `detectedType` ('jpg' | 'png' | 'pdf' | 'docx' | 'pptx'). Multer's own
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

const megabytesOf = (bytes) => bytes / (1024 * 1024);

// Several required files in one request, one under each name, each with its own
// `maxBytes` and `types` (governing-body ticket 03: a KTP and a proof of office). On
// success req.files[name] is that file, with its `detectedType`. multer stops a file
// past the largest limit; each one's own limit is checked after it, so the answer
// names the file and the limit it broke.
function fileFields(specs) {
    const names = Object.keys(specs);
    const largest = Math.max(...names.map((name) => specs[name].maxBytes));
    const parse = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: largest, files: names.length },
    }).fields(names.map((name) => ({ name, maxCount: 1 })));

    return (req, res, next) => {
        parse(req, res, (error) => {
            if (error instanceof multer.MulterError) {
                const spec = specs[error.field];
                const message =
                    error.code === 'LIMIT_FILE_SIZE' && spec
                        ? `The ${error.field} file must be at most ${megabytesOf(spec.maxBytes)} MB`
                        : `Invalid upload: ${error.message}`;
                return next(badRequest(message, { field: error.field }));
            }
            if (error) return next(error);

            const files = {};
            for (const name of names) {
                const { maxBytes, types } = specs[name];
                const file = req.files?.[name]?.[0];
                if (!file) return next(badRequest(`The ${name} file is required`, { field: name }));
                if (file.size > maxBytes) {
                    const message = `The ${name} file must be at most ${megabytesOf(maxBytes)} MB`;
                    return next(badRequest(message, { field: name }));
                }

                const detected = detectType(file.buffer);
                if (!detected || !types.includes(detected)) {
                    const allowed = types.join(', ').toUpperCase();
                    return next(badRequest(`The ${name} file must be one of: ${allowed}`, { field: name }));
                }
                files[name] = { ...file, detectedType: detected };
            }

            req.files = files;
            return next();
        });
    };
}

export { singleFile, fileFields, detectType, MIME };
