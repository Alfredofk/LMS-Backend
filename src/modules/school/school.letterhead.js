import path from 'node:path';

import { prisma } from '../../shared/prisma.js';
import { getStorage } from '../../shared/storage.js';
import { MIME } from '../../shared/upload.js';
import { recordAudit } from '../../shared/approval.js';
import { isPrincipal } from '../../shared/guards.js';
import { badRequest, forbidden, notFound } from '../../shared/errors.js';
import { pngSizeOf, drawnSizeOf } from '../../shared/pdfImage.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('School');

// The School's letterhead (grading-and-report-card ticket 10): its address, its phone
// and its logo, which every Report Card the School closes from then on carries above
// its title (grading.close.js freezes them, grading.pdf.js prints them).
//
// Owner's decisions (2026-10-20, the ticket and its build plan):
// - The Principal's alone, as the school's point and time zone are, and audited
//   UPDATE_LETTERHEAD against the School with what it was before.
// - The address and the phone are free text, at most 300 and 30 characters; null
//   clears one.
// - The logo is a JPG or PNG of at most 2 MB and 2000 x 2000 pixels, kept only once
//   pdfkit has drawn it on a thread of its own (src/shared/pdfImage.js): a broken PNG
//   would otherwise kill the server at print time.
// - Each upload is a new file, never written over, and a replaced or removed one stays
//   in storage: a closed Report Card keeps printing the logo it was closed with.

const SCHOOL_SUBJECT = 'School';
const LOGO_FOLDER = 'logos';

// The longest side a logo may have: a transparent PNG is decoded whole to be printed,
// four bytes a pixel.
const MAX_LOGO_SIDE = 2000;

const letterheadSelect = { name: true, address: true, phone: true, logoStorageKey: true };

// What the Principal reads of it; the logo's storage key stays on the server.
const letterheadView = (school) => ({
    address: school.address,
    phone: school.phone,
    hasLogo: school.logoStorageKey !== null,
});

const shown = (value) => (value === null ? 'none' : `"${value}"`);

const tooLarge = (size) => size.width > MAX_LOGO_SIDE || size.height > MAX_LOGO_SIDE;

async function assertPrincipalHere(auth) {
    if (!(await isPrincipal(auth.membershipId))) throw forbidden('Only the Principal can do this');
}

async function loadLetterhead(auth, client = prisma) {
    const school = await client.school.findUnique({ where: { id: auth.schoolId }, select: letterheadSelect });
    if (!school) throw notFound('School not found');
    return school;
}

// ---------------------------------------------------------------------------
// The address and the phone
// ---------------------------------------------------------------------------

// The Principal sets the address, the phone or both; null clears one. Audited with
// what each was, in the same transaction; a save that changes nothing writes nothing.
// Refused at a deactivated school, as the location is.
async function updateLetterhead(auth, { address, phone }) {
    await assertPrincipalHere(auth);
    const data = {};
    if (address !== undefined) data.address = address;
    if (phone !== undefined) data.phone = phone;

    let changes = [];
    const school = await prisma.$transaction(async (tx) => {
        const before = await loadLetterhead(auth, tx);
        changes = Object.keys(data).filter((key) => before[key] !== data[key]);
        if (changes.length === 0) return before;
        const claimed = await tx.school.updateMany({ where: { id: auth.schoolId, deactivatedAt: null }, data });
        if (claimed.count === 0) throw notFound('School not found');
        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: SCHOOL_SUBJECT,
            subjectId: auth.schoolId,
            action: 'UPDATE_LETTERHEAD',
            actorUserId: auth.userId,
            reason: changes.map((key) => `${key} was ${shown(before[key])}`).join('; '),
            client: tx,
        });
        return loadLetterhead(auth, tx);
    });

    if (changes.length) log.info(`Letterhead of ${school.name}: ${changes.join(' and ')} changed`);
    return letterheadView(school);
}

// ---------------------------------------------------------------------------
// The logo
// ---------------------------------------------------------------------------

// Refuses (400) a logo the Report Card could not print: a PNG whose header cannot be
// read, one larger than 2000 x 2000 pixels - read from the header first, before it is
// decoded - or any image pdfkit fails to draw on its own thread.
async function assertPrintable(file) {
    const header = file.detectedType === 'png' ? pngSizeOf(file.buffer) : null;
    if (file.detectedType === 'png' && !header) {
        throw badRequest('This PNG cannot be read; save it again and upload it', { field: 'logo' });
    }
    const tooBig = badRequest(`The logo may be at most ${MAX_LOGO_SIDE} x ${MAX_LOGO_SIDE} pixels`, {
        field: 'logo',
        maxSide: MAX_LOGO_SIDE,
    });
    if (header && tooLarge(header)) throw tooBig;
    const size = await drawnSizeOf(file.buffer);
    if (!size) {
        throw badRequest('This image cannot be printed on the Report Card; save it again as a JPG or PNG', {
            field: 'logo',
        });
    }
    if (tooLarge(size)) throw tooBig;
}

// The Principal sets the School's logo, a JPG or PNG the Report Card can print. Saved as
// a new file first, then pointed at, audited, in one transaction; removed again if that
// fails. The logo it replaces stays in storage.
async function setLogo(auth, file) {
    await assertPrincipalHere(auth);
    await assertPrintable(file);

    const storage = getStorage();
    const key = await storage.save(file.buffer, {
        folder: `${LOGO_FOLDER}/${auth.schoolId}`,
        originalName: `logo.${file.detectedType}`,
    });
    let school;
    try {
        school = await prisma.$transaction(async (tx) => {
            const before = await loadLetterhead(auth, tx);
            const claimed = await tx.school.updateMany({
                where: { id: auth.schoolId, deactivatedAt: null },
                data: { logoStorageKey: key },
            });
            if (claimed.count === 0) throw notFound('School not found');
            await recordAudit({
                schoolId: auth.schoolId,
                subjectType: SCHOOL_SUBJECT,
                subjectId: auth.schoolId,
                action: 'UPDATE_LETTERHEAD',
                actorUserId: auth.userId,
                reason: before.logoStorageKey ? 'logo replaced' : 'logo added',
                client: tx,
            });
            return loadLetterhead(auth, tx);
        });
    } catch (error) {
        await storage.remove(key);
        throw error;
    }

    log.info(`Logo of ${school.name} set`);
    return letterheadView(school);
}

// The Principal takes the logo off: Report Cards closed from now on carry none. Its
// file stays, for the closed ones that print it. Audited; none to take off writes nothing.
async function removeLogo(auth) {
    await assertPrincipalHere(auth);
    let removed = false;
    const school = await prisma.$transaction(async (tx) => {
        const before = await loadLetterhead(auth, tx);
        if (!before.logoStorageKey) return before;
        const claimed = await tx.school.updateMany({
            where: { id: auth.schoolId, deactivatedAt: null, logoStorageKey: before.logoStorageKey },
            data: { logoStorageKey: null },
        });
        if (claimed.count === 0) throw notFound('School not found');
        await recordAudit({
            schoolId: auth.schoolId,
            subjectType: SCHOOL_SUBJECT,
            subjectId: auth.schoolId,
            action: 'UPDATE_LETTERHEAD',
            actorUserId: auth.userId,
            reason: 'logo removed',
            client: tx,
        });
        removed = true;
        return loadLetterhead(auth, tx);
    });

    if (removed) log.info(`Logo of ${school.name} removed`);
    return letterheadView(school);
}

// The current logo's bytes, for the Principal's settings; 404 while there is none.
async function readLogo(auth) {
    await assertPrincipalHere(auth);
    const school = await loadLetterhead(auth);
    if (!school.logoStorageKey) throw notFound('The school has no logo');
    const type = path.extname(school.logoStorageKey).slice(1);
    return {
        buffer: await getStorage().read(school.logoStorageKey),
        contentType: MIME[type],
        fileName: `logo.${type}`,
    };
}

export { letterheadView, updateLetterhead, setLogo, removeLogo, readLogo };
