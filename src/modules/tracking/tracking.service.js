import { prisma } from '../../shared/prisma.js';
import { createLogger } from '../../lib/helpers.js';
import { readableByStudent, studentProfileOf } from '../content/content.service.js';
import { CONTENT_VERBS, recordContentEvent } from './tracking.record.js';

const log = createLogger('Tracking');

// A student's own Learning Events, sent by the frontend in batches
// (teaching-and-learning ticket 05). What each verb means, and what it completes,
// is tracking.record.js's.
//
// - The actor is the caller: the token's membership, never anything in the body.
// - Each Content must be one the student reaches now: published, live, under a
//   Session of the Class they sit in (readableByStudent). Every miss - a draft,
//   another Class's, another school's, one that is gone - is the same "Content not
//   found", so the route answers nothing about what exists.
// - occurredAt is the device's, bounded: no more than 5 minutes ahead (a clock
//   running fast), no more than a day old.
// - Every accepted event, with the progress it moves, is written in one
//   transaction.
// - Always 200, with an answer per event, as a bulk approval answers: a batch is
//   not lost for one stale item, and the frontend learns which one it was.

const MAX_AHEAD_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CONTENT_NOT_FOUND = 'Content not found';

const refused = (index, code, message) => ({ index, ok: false, error: { code, message } });

async function recordClientEvents(auth, { events }) {
    const receivedAt = new Date();
    const studentProfileId = await studentProfileOf(auth);

    // Each Content is looked up once, however many events name it.
    const reach = new Map();
    const reachOf = async (contentId) => {
        if (!reach.has(contentId)) reach.set(contentId, await readableByStudent(auth, contentId));
        return reach.get(contentId);
    };

    const results = new Array(events.length);
    const accepted = [];
    for (const [index, event] of events.entries()) {
        const occurredAt = event.occurredAt ?? receivedAt;
        if (occurredAt.getTime() > receivedAt.getTime() + MAX_AHEAD_MS) {
            results[index] = refused(index, 'BAD_REQUEST', 'occurredAt is in the future');
            continue;
        }
        if (occurredAt.getTime() < receivedAt.getTime() - MAX_AGE_MS) {
            results[index] = refused(index, 'BAD_REQUEST', 'occurredAt is more than a day old');
            continue;
        }

        const target = studentProfileId ? await reachOf(event.contentId) : null;
        if (!target) {
            results[index] = refused(index, 'NOT_FOUND', CONTENT_NOT_FOUND);
            continue;
        }
        if (!CONTENT_VERBS[event.verb].fits(target.content)) {
            const message = `${event.verb} does not apply to this ${target.content.type}`;
            results[index] = refused(index, 'BAD_REQUEST', message);
            continue;
        }
        accepted.push({ index, event, occurredAt, target });
    }

    if (accepted.length > 0) {
        await prisma.$transaction(async (tx) => {
            for (const { index, event, occurredAt, target } of accepted) {
                const { recorded } = await recordContentEvent(tx, {
                    actorMembershipId: auth.membershipId,
                    studentProfileId,
                    content: target.content,
                    session: target.session,
                    verb: event.verb,
                    occurredAt,
                    position: event.position,
                    duration: event.duration,
                });
                results[index] = { index, ok: true, recorded };
            }
        });
    }

    const summary = {
        recorded: results.filter((entry) => entry.ok && entry.recorded).length,
        notRecorded: results.filter((entry) => entry.ok && !entry.recorded).length,
        refused: results.filter((entry) => !entry.ok).length,
    };
    log.info(`Learning events at ${auth.schoolName}: ${summary.recorded} recorded, ${summary.refused} refused`);
    return { results, summary };
}

export { recordClientEvents };
