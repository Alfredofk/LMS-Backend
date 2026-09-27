import { AppError } from '../../shared/errors.js';
import { createLogger } from '../../lib/helpers.js';

const log = createLogger('Holidays');

// Where a year's national holidays are fetched from (teaching-and-learning 08).
//
// TECH DEBT (.scratch/tech-debt/issues/01-national-holiday-source.md): an
// unofficial community source, accepted by the owner until the project is
// finished. Not a design to build on - replace it through `holidaySource` below.
//
// There is no official government API: the SKB 3 Menteri is published each year
// as a document. This community one (github.com/andifahruddinakas/api-hari-libur,
// ISC) is scraped daily from tanggalans.com - a third party - so what it returns
// is only ever a DRAFT for the Platform Admin to check against the SKB. Checked on
// 2026-09-27 it held 2026's 17 national holidays but 7 of its 8 joint-leave days.
//
// It answers { status, code, data: [{ date: 'YYYY-MM-DD', description }] } and
// does not say which days are joint leave. Their descriptions start "Cuti
// Bersama", so that is read as a suggestion the admin confirms or corrects.
const SOURCE = 'api-hari-libur';
const SOURCE_URL = 'https://api-hari-libur.vercel.app/api';
const TIMEOUT_MS = 10_000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const failed = (message) => new AppError(502, 'HOLIDAY_SOURCE_FAILED', message);

async function fetchYear(year) {
    let response;
    try {
        response = await fetch(`${SOURCE_URL}?year=${year}`, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        log.warn(`Holiday source unreachable: ${error.message}`);
        throw failed('The holiday source could not be reached. Add the holidays by hand.');
    }
    if (!response.ok) {
        log.warn(`Holiday source answered ${response.status}`);
        throw failed(`The holiday source answered ${response.status}. Add the holidays by hand.`);
    }

    let body;
    try {
        body = await response.json();
    } catch {
        throw failed('The holiday source answered something that is not JSON.');
    }
    if (!Array.isArray(body?.data)) throw failed('The holiday source answered in a shape it never used.');

    // Anything malformed is dropped rather than trusted, and only this year's days
    // are kept.
    return body.data
        .filter((entry) => typeof entry?.date === 'string' && DATE.test(entry.date))
        .filter((entry) => entry.date.startsWith(`${year}-`))
        .filter((entry) => typeof entry.description === 'string' && entry.description.trim())
        .map((entry) => {
            const name = entry.description.trim().slice(0, 150);
            return {
                date: entry.date,
                name,
                kind: /^cuti bersama/i.test(name) ? 'JOINT_LEAVE' : 'NATIONAL',
            };
        });
}

// An object rather than a bare function so a probe can swap fetchYear() for a
// fake and never call the outside world - the pattern of shared/google.js.
const holidaySource = { name: SOURCE, fetchYear };

export { holidaySource };
