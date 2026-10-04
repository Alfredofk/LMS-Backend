import { z } from 'zod';

// Learning Events from the frontend (teaching-and-learning ticket 05). Only the
// shape is checked here; whether the student may reach the Content, and whether
// the verb fits its type, is the service's.
//
// The verbs a client may send, each with its own shape - a closed list, so an
// unknown verb, or one the server writes itself (content.file_downloaded), refuses
// the whole batch. Strict throughout: the actor is the caller, taken from the
// token, so a body naming one is refused rather than ignored.

const contentId = z.string().min(1);

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

const event = z.discriminatedUnion('verb', [
    plain('content.opened'),
    videoProgressed,
    plain('content.text_read_to_end'),
    plain('content.link_clicked'),
]);

// At most 50 at once: a page sends what it gathered since the last send.
const eventsBody = z.strictObject({
    events: z.array(event).min(1, 'Send at least one event').max(50, 'At most 50 events at once'),
});

export { eventsBody };
