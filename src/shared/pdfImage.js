import { Worker } from 'node:worker_threads';

// Whether pdfkit can draw an image, asked before one is kept to be printed - the
// School's logo on its Report Cards (grading-and-report-card ticket 10, owner
// 2026-10-20).
//
// pdfkit draws every JPG and PNG it can parse, interlaced, 16-bit and transparent ones
// included. But its PNG decoding (png-js) throws inside a zlib callback on a broken
// image - a bad deflate stream, a bad filter byte - and that kills the process; a
// truncated one may never finish. So each image is drawn once, on a worker thread of
// its own with a time limit, and what passes there draws the same way at print time:
// the file kept is never changed.

const DRAW_TIMEOUT_MS = 5_000;

const WORKER = new URL('./pdfImage.worker.js', import.meta.url);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// A PNG's width and height from its header, the first chunk, read before any decoding:
// a huge one is refused before it is drawn. Null for a buffer that is no PNG or whose
// header is not where it must be.
function pngSizeOf(buffer) {
    const signed = buffer.length >= 24 && PNG_SIGNATURE.every((byte, index) => buffer[index] === byte);
    if (!signed || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// The size pdfkit draws an image at, { width, height }, or null when it cannot: the
// worker throws, dies, or runs past the time limit.
function drawnSizeOf(buffer, timeoutMs = DRAW_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const worker = new Worker(WORKER, { workerData: buffer });
        let settled = false;
        const settle = (size) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            worker.terminate();
            resolve(size);
        };
        const timer = setTimeout(() => settle(null), timeoutMs);
        worker.once('message', settle);
        worker.once('error', () => settle(null));
        worker.once('exit', () => settle(null));
    });
}

export { pngSizeOf, drawnSizeOf };
