import { z } from 'zod';

// A weekly slot in the school's own time zone (teaching-and-learning ticket 02).
// 'HH:mm', 24-hour. ISO day of the week: 1 Monday ... 7 Sunday.
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the form HH:mm, 24-hour');
const minuteOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const slot = z
    .strictObject({
        dayOfWeek: z.number().int().min(1, 'Monday is 1').max(7, 'Sunday is 7'),
        start: time,
        end: time,
    })
    .refine((value) => minuteOf(value.end) > minuteOf(value.start), {
        path: ['end'],
        message: 'A slot must end after it starts',
    });

const overlap = (a, b) =>
    a.dayOfWeek === b.dayOfWeek &&
    minuteOf(a.start) < minuteOf(b.end) &&
    minuteOf(b.start) < minuteOf(a.end);

// The whole week at once: a schedule is replaced whole, never edited slot by slot.
// Slots of one ClassSubject may not overlap each other; clashes with OTHER classes
// and teachers need the database, so the service checks those.
const scheduleBody = z
    .strictObject({ slots: z.array(slot).min(1, 'Give at least one weekly slot').max(30) })
    .superRefine((value, ctx) => {
        value.slots.forEach((a, i) => {
            value.slots.slice(i + 1).forEach((b, offset) => {
                if (overlap(a, b)) {
                    ctx.addIssue({
                        code: 'custom',
                        path: ['slots', i + 1 + offset],
                        message: 'Two slots of this schedule overlap',
                    });
                }
            });
        });
    });

const idParams = z.object({ id: z.string().min(1) });

const sessionsQuery = z.object({ status: z.enum(['SCHEDULED', 'CANCELLED']).optional() });

// A day of the school's calendar, 'YYYY-MM-DD'. A date that does not exist is
// refused, not rolled over (the same check as holidays.schema.js).
const realDay = (value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const mineQuery = z.object({
    date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD')
        .refine(realDay, 'That date does not exist')
        .optional(),
});

export { scheduleBody, idParams, sessionsQuery, mineQuery };
