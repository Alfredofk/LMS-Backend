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

const liveContentOf = (tx, sessionId) =>
    tx.content.findMany({
        where: { sessionId, deletedAt: null },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
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
// the order it was planned. Returns how many Content moved.
async function moveContentOffHoliday(tx, classSubjectId, cancelled) {
    let moved = 0;
    const inOrder = [...cancelled].sort((a, b) => a.startsAt - b.startsAt);

    for (const session of inOrder) {
        const items = await liveContentOf(tx, session.id);
        if (items.length === 0) continue;

        // No SCHEDULED Session left at all: it stays, and students still open it.
        const target = await receivingSession(tx, classSubjectId, session);
        if (!target) continue;

        const last = await tx.content.aggregate({
            where: { sessionId: target.id, deletedAt: null },
            _max: { order: true },
        });
        let order = last._max.order ?? 0;
        for (const item of items) {
            order += 1;
            await tx.content.updateMany({ where: { id: item.id }, data: { sessionId: target.id, order } });
        }
        moved += items.length;
    }
    return moved;
}

export { moveContentOffHoliday };
