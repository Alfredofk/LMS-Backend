import { z } from 'zod';

// Attendance (teaching-and-learning ticket 03). Only the shape is checked here;
// who may do what, and when, is the service's.

const id = z.string().min(1);

const idParams = z.object({ id });

// The device's location. Used for the two flags and dropped: nothing here is
// stored or logged (UU PDP Pasal 16, 25). Strict, so a check-in can never name
// a student - the student is the caller.
const checkInBody = z.strictObject({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
});

// Hadir, Sakit, Izin, Alpa.
const status = z.enum(['PRESENT', 'SICK', 'EXCUSED', 'ABSENT']);

// Left loose: the service owns "a note of at least 3 characters" after
// confirmation, the way approval.js owns a rejection's reason.
const note = z.string().max(500, 'Note is too long').optional();

// The teacher's confirmation. Everyone not named keeps the default: PRESENT if
// they checked in, ABSENT if not. No body at all is the same as no changes.
const confirmBody = z
    .strictObject({
        statuses: z
            .array(z.strictObject({ studentProfileId: id, status, note }))
            .max(200)
            .optional(),
    })
    .default({});

const attendancePatch = z.strictObject({ status, note });

const mineQuery = z.object({ classSubjectId: id.optional() });

export { idParams, checkInBody, confirmBody, attendancePatch, mineQuery };
