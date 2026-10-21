import { parentPort, workerData } from 'node:worker_threads';
import PDFDocument from 'pdfkit';

// Draws the image it is given into a throwaway PDF, as the Report Card would, and
// answers its size once the document has ended - or dies trying. Run on a thread of
// its own by pdfImage.js: pdfkit's PNG decoding (png-js) throws inside a zlib callback,
// where nothing can catch it, so a broken image would take the server down with it
// (grading-and-report-card ticket 10).

const doc = new PDFDocument({ size: 'A4' });
doc.on('data', () => {});
const image = doc.openImage(Buffer.from(workerData));
doc.on('end', () => parentPort.postMessage({ width: image.width, height: image.height }));
doc.image(image, 0, 0, { fit: [100, 100] });
doc.end();
