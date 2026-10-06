// What a student has of each Session's Content: how many are published, and how many
// of those they completed (teaching-and-learning 06 follow-up 2, owner 2026-10-06,
// asked by the frontend for the ticks on its Session tabs). sessions.service.js reads
// it for a student's Session list, and content.service.js imports sessions.service.js,
// so it lives here, takes its client and imports nothing, as content.moves.js does.
//
// - Published is READABLE_BY_STUDENT, a cancelled Session's included: what the
//   student's Content list shows and the progress views count.
// - Completed is the student's own ContentProgress.completedAt on those: the ticks
//   that list shows.
// So the frontend's "done" badge - at least one published, every one completed - reads
// the same from either.

// What a student may read: published, and not deleted. content.service.js and the
// progress views (teaching-and-learning 06) count Content by the same rule.
const READABLE_BY_STUDENT = { publishedAt: { not: null }, deletedAt: null };

// { published, completed } for each of these Sessions, 0 and 0 for one with nothing
// published. One query, however many Sessions.
async function summaryBySessionOf(client, studentProfileId, sessionIds) {
    const rows = await client.content.findMany({
        where: { sessionId: { in: sessionIds }, ...READABLE_BY_STUDENT },
        select: {
            sessionId: true,
            progress: { where: { studentProfileId, completedAt: { not: null } }, select: { id: true } },
        },
    });

    const summary = new Map(sessionIds.map((id) => [id, { published: 0, completed: 0 }]));
    for (const row of rows) {
        const entry = summary.get(row.sessionId);
        entry.published += 1;
        if (row.progress.length > 0) entry.completed += 1;
    }
    return summary;
}

export { READABLE_BY_STUDENT, summaryBySessionOf };
