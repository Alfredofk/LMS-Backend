// The one writer of LearningEvent, and of the ContentProgress derived from it
// (teaching-and-learning ticket 05, handoff #11, #24). Imports nothing but what
// every caller passes in, so content, attendance and tracking all use it without
// an import cycle.
//
// Owner's decisions (2026-09-27 and 2026-10-04):
// - A Learning Event is append-only. Nothing here updates or deletes one, and the
//   database refuses it too (the trigger in the _add_learning_events migration).
// - Completion is automatic per Content type, from what the frontend reports, so a
//   signal and not proof (handoff #15). Nothing is penalised on it.
// - A YouTube VIDEO's progress is kept per 10%: a report becomes an event only when
//   it reaches a tenth not reached before. A report per second never becomes a row
//   per second, and the progress stays derivable from the log.
//
// Every write takes the caller's client: a transaction, so an event and the
// progress it moves commit together or not at all (handoff #24).

// Watched this far, a VIDEO is complete (owner's default, 2026-09-27).
const VIDEO_COMPLETE_AT = 0.8;

// The verbs that act on one Content for one student, with what each applies to
// and whether it completes it. `client` says whether the frontend may send it;
// content.file_downloaded is the server's, written when the file is fetched.
//
// A VIDEO kept as another site's link has no player that could report progress,
// so it completes when its link is clicked, as a LINK does.
const CONTENT_VERBS = {
    'content.opened': {
        client: true,
        fits: () => true,
        completes: (content) => content.type === 'FILE',
    },
    'content.video_progressed': {
        client: true,
        fits: (content) => content.type === 'VIDEO' && content.payload.provider === 'YOUTUBE',
        completes: (_content, { position, duration }) => position >= duration * VIDEO_COMPLETE_AT,
    },
    'content.text_read_to_end': {
        client: true,
        fits: (content) => content.type === 'TEXT',
        completes: () => true,
    },
    'content.link_clicked': {
        client: true,
        fits: (content) => content.type === 'LINK' || (content.type === 'VIDEO' && content.payload.provider === 'OTHER'),
        completes: () => true,
    },
    'content.file_downloaded': {
        client: false,
        fits: (content) => content.type === 'FILE',
        completes: () => true,
    },
};

// Server-written, with nothing to derive.
const OTHER_VERBS = new Set(['content.published', 'attendance.checked_in', 'attendance.confirmed']);

const CLIENT_VERBS = Object.keys(CONTENT_VERBS).filter((verb) => CONTENT_VERBS[verb].client);

// The tenth of a video reached, 0 to 10. A player can report a position a little
// past the end, hence the cap.
const tenthOf = (position, duration) => Math.min(10, Math.floor((position / duration) * 10));

const storedTenth = (row) =>
    row?.videoPositionSeconds != null && row.videoDurationSeconds
        ? tenthOf(row.videoPositionSeconds, row.videoDurationSeconds)
        : 0;

// The furthest point reached, in seconds of this report's duration. A player may
// report a different duration for the same video from one report to the next.
// Seconds kept against one duration and read against another overstate how far it
// was watched: 150 s of 1000 read as 150 s of 180 is 83%, and a later report at
// 89% would then reach no new tenth and never complete it. So the point carries
// over as a share of the video (review of the teaching-and-learning 06 follow-up,
// owner 2026-10-04). With an unchanged duration it is the stored point itself.
const furthestIn = (row, duration) =>
    row.videoPositionSeconds != null && row.videoDurationSeconds
        ? (row.videoPositionSeconds / row.videoDurationSeconds) * duration
        : 0;

const earlier = (a, b) => (a && a < b ? a : b);
const later = (a, b) => (a && a > b ? a : b);

// A Learning Event, as it happened. schoolId is stamped by the tenant extension.
async function recordEvent(
    client,
    { actorMembershipId, verb, objectType, objectId, context = {}, occurredAt = new Date() }
) {
    if (!CONTENT_VERBS[verb] && !OTHER_VERBS.has(verb)) {
        throw new Error(`Unknown Learning Event verb: ${verb}`);
    }
    return client.learningEvent.create({
        data: { actorMembershipId, verb, objectType, objectId, context, occurredAt },
    });
}

// The progress row, made if missing and locked for this transaction: a second
// batch for the same Content and student waits here, the row lock addRoles takes.
async function lockProgress(client, contentId, studentProfileId, occurredAt) {
    await client.contentProgress.createMany({
        data: [{ contentId, studentProfileId, lastActivityAt: occurredAt }],
        skipDuplicates: true,
    });
    await client.contentProgress.updateMany({
        where: { contentId, studentProfileId },
        data: { updatedAt: new Date() },
    });
    return client.contentProgress.findFirst({ where: { contentId, studentProfileId } });
}

// One student's act on one Content: the event, and the progress it moves, in the
// caller's transaction. The caller has checked that the student may reach it and
// that the verb fits its type.
//
// A video report that reaches no new tenth writes nothing and answers
// { recorded: false }. It is looked at once without the lock - most reports stop
// there - and again under it, so two batches racing past the same tenth record it
// once.
//
// Every answer says whether the Content is now complete for the student, recorded
// or not, so the frontend can tick it without reading the list again
// (teaching-and-learning 06 follow-up, owner 2026-10-04). A report that reaches no
// new tenth cannot complete a video: the furthest point is kept as a share of the
// video (furthestIn), so a stored eighth tenth means a report reached 80% and
// completed it.
async function recordContentEvent(
    client,
    { actorMembershipId, studentProfileId, content, session, verb, occurredAt, position, duration }
) {
    const rule = CONTENT_VERBS[verb];
    const video = verb === 'content.video_progressed';
    const reached = video ? tenthOf(position, duration) : null;

    if (video) {
        const seen = await client.contentProgress.findFirst({ where: { contentId: content.id, studentProfileId } });
        if (reached <= storedTenth(seen)) return { recorded: false, completed: Boolean(seen?.completedAt) };
    }

    const row = await lockProgress(client, content.id, studentProfileId, occurredAt);
    if (video && reached <= storedTenth(row)) return { recorded: false, completed: Boolean(row.completedAt) };

    await recordEvent(client, {
        actorMembershipId,
        verb,
        objectType: 'Content',
        objectId: content.id,
        context: {
            contentType: content.type,
            sessionId: content.sessionId,
            classSubjectId: session.classSubject.id,
            ...(video ? { position, duration } : {}),
        },
        occurredAt,
    });

    const data = {
        firstOpenedAt: earlier(row.firstOpenedAt, occurredAt),
        lastActivityAt: later(row.lastActivityAt, occurredAt),
    };
    if (video) {
        data.videoPositionSeconds = Math.max(furthestIn(row, duration), Math.min(position, duration));
        data.videoDurationSeconds = duration;
    }
    if (!row.completedAt && rule.completes(content, { position, duration })) data.completedAt = occurredAt;

    await client.contentProgress.updateMany({ where: { id: row.id }, data });
    return { recorded: true, completed: Boolean(row.completedAt ?? data.completedAt) };
}

export { CONTENT_VERBS, CLIENT_VERBS, VIDEO_COMPLETE_AT, recordEvent, recordContentEvent };
