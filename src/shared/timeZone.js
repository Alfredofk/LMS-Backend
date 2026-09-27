// A school's schedule is written in its own time zone (teaching-and-learning
// ticket 07): WIB, WITA or WIT. Timestamps are stored UTC everywhere; this is
// where a school's local date and time turn into one, and back.
//
// No library, on purpose. Indonesia keeps no daylight saving, so each zone is a
// fixed offset and the arithmetic is exact. (CLAUDE.md's Asia/Jakarta rule is for
// the backend's own log lines and /health - not for a school's timetable.)

const OFFSET_HOURS = { WIB: 7, WITA: 8, WIT: 9 };
const TIME_ZONES = Object.keys(OFFSET_HOURS);
const HOUR = 60 * 60 * 1000;

function offsetOf(zone) {
    const hours = OFFSET_HOURS[zone];
    if (hours === undefined) throw new Error(`Unknown school time zone: ${zone}`);
    return hours * HOUR;
}

// '2026-07-13' and '07:30' in WITA -> the UTC instant (2026-07-12T23:30:00.000Z).
function localToUtc(date, time, zone) {
    const [year, month, day] = date.split('-').map(Number);
    const [hours, minutes] = time.split(':').map(Number);
    return new Date(Date.UTC(year, month - 1, day, hours, minutes) - offsetOf(zone));
}

// The UTC instant -> the school's local date ('YYYY-MM-DD'), time ('HH:mm') and
// ISO day of week (1 Monday ... 7 Sunday, the way a timetable is read).
function utcToLocal(instant, zone) {
    const shifted = new Date(instant.getTime() + offsetOf(zone));
    const iso = shifted.toISOString();
    return {
        date: iso.slice(0, 10),
        time: iso.slice(11, 16),
        dayOfWeek: shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay(),
    };
}

export { TIME_ZONES, localToUtc, utcToLocal };
