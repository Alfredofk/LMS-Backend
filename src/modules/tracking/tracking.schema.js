import { z } from 'zod';

// Learning Events from the frontend (teaching-and-learning ticket 05), and the
// integrity signals during an attempt (assessment ticket 06). Only the shape is
// checked here; whether the student may reach the Content, whether the verb fits its
// type, and whether the Submission takes a signal, is the service's.
//
// The verbs a client may send, each with its own shape - a closed list, so an
// unknown verb, or one the server writes itself (content.file_downloaded), refuses
// the whole batch. Strict throughout: the actor is the caller, taken from the
// token, so a body naming one is refused rather than ignored.

const contentId = z.string().min(1);
const submissionId = z.string().min(1);

// When it happened on the device, as ISO 8601. The service bounds it; left out, it
// is the moment the server received it.
const occurredAt = z.coerce.date().optional();

const plain = (verb) => z.strictObject({ verb: z.literal(verb), contentId, occurredAt });

// Where the player is, and how long the video is, both in seconds.
const videoProgressed = z.strictObject({
    verb: z.literal('content.video_progressed'),
    contentId,
    occurredAt,
    position: z.number().min(0),
    duration: z.number().positive().max(24 * 60 * 60),
});

// An integrity signal, naming the Submission in progress it happened in (assessment
// ticket 06). One batch may mix them with Content's events.
const signal = (verb) => z.strictObject({ verb: z.literal(verb), submissionId, occurredAt });

const event = z.discriminatedUnion('verb', [
    plain('content.opened'),
    videoProgressed,
    plain('content.text_read_to_end'),
    plain('content.link_clicked'),
    signal('assessment.focus_lost'),
    signal('assessment.pasted'),
    signal('assessment.copied'),
    signal('assessment.fullscreen_exited'),
]);

// At most 50 at once: a page sends what it gathered since the last send.
const eventsBody = z.strictObject({
    events: z.array(event).min(1, 'Send at least one event').max(50, 'At most 50 events at once'),
});

// A ClassSubject's progress (ticket 06).
const idParams = z.object({ id: z.string().min(1) });

export { eventsBody, idParams };
