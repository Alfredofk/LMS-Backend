// Content leaving a Session cancelled for a holiday (teaching-and-learning 04, owner
// 2026-09-28; corrected 2026-09-29, ticket 09 E). Read by sessions.service.js, which
// cancels the Session and calls this in the same transaction. It imports nothing of
// sessions, so the two modules do not import each other.
//
// - Its Content goes to the next SCHEDULED Session of the same ClassSubject, after
//   that Session's own. The next scheduled one, not the next number: a number
//   cancelled too is passed over.
// - With none after it, the previous SCHEDULED one takes it, even one already past.
// - Drafts move with it. What was deleted stays where it is.
// - Only a HOLIDAY cancellation moves Content. A number brought back later returns
//   empty: what moved on does not move back.

// A Session's live Content in the order it is shown. content.service.js reads both
// helpers too; they live here because sessions.service.js imports this file, and
// content.service.js imports sessions.service.js.
const CONTENT_ORDER = [{ order: 'asc' }, { createdAt: 'asc' }];

// The highest order among a Session's live Content, 0 when it has none.
async function lastOrderOf(client, sessionId) {
    const last = await client.content.aggregate({
        where: { sessionId, deletedAt: null },
        _max: { order: true },
    });
    return last._max.order ?? 0;
}

const liveContentOf = (tx, sessionId) =>
    tx.content.findMany({
        where: { sessionId, deletedAt: null },
        orderBy: CONTENT_ORDER,
        select: { id: true },
    });

async function receivingSession(tx, classSubjectId, cancelled) {
    const scheduled = { classSubjectId, status: 'SCHEDULED' };
    const after = await tx.session.findFirst({
        where: { ...scheduled, startsAt: { gt: cancelled.startsAt } },
        orderBy: { startsAt: 'asc' },
        select: { id: true },
    });
    if (after) return after;
    return tx.session.findFirst({
        where: { ...scheduled, startsAt: { lt: cancelled.startsAt } },
        orderBy: { startsAt: 'desc' },
        select: { id: true },
    });
}

// `cancelled`: the Sessions just cancelled, each { id, startsAt }, already CANCELLED
// in `tx`. Taken in date order, so a week of them lands on the next taught day in
// the order it was planned.
async function moveContentOffHoliday(tx, classSubjectId, cancelled) {
    const inOrder = [...cancelled].sort((a, b) => a.startsAt - b.startsAt);

    for (const session of inOrder) {
        const items = await liveContentOf(tx, session.id);
        if (items.length === 0) continue;

        // No SCHEDULED Session left at all: it stays, and students still open it. If
        // this number is brought back later it returns with its Content, the one
        // exception to "returns empty" (review 2026-10-03, ticket 04).
        const target = await receivingSession(tx, classSubjectId, session);
        if (!target) continue;

        let order = await lastOrderOf(tx, target.id);
        for (const item of items) {
            order += 1;
            await tx.content.updateMany({ where: { id: item.id }, data: { sessionId: target.id, order } });
        }
    }
}

export { CONTENT_ORDER, lastOrderOf, moveContentOffHoliday };
