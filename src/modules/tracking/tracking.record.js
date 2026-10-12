// The one writer of LearningEvent, and of the ContentProgress derived from it
// (teaching-and-learning ticket 05, handoff #11, #24), and of a Submission's
// integrity counts (assessment ticket 06). Imports nothing but what every caller
// passes in, so content, attendance, assessment and tracking all use it without an
// import cycle.
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

// Server-written, with nothing to derive. The assessment ones (ticket 06) are each
// written in the transaction of the act they record: publishing, starting, handing
// in - by the Student, or by time - and releasing.
const OTHER_VERBS = new Set([
    'content.published',
    'attendance.checked_in',
    'attendance.confirmed',
    'assessment.published',
    'assessment.submission_started',
    'assessment.submitted',
    'assessment.released',
]);

// The integrity signals a Student's frontend reports during an attempt at a KUIS, a
// UTS or a UAS (assessment ticket 06, owner 2026-10-04), each with the Submission
// column that counts it. Advisory (handoff #15): counted for the staff, never
// penalised.
const SIGNAL_VERBS = {
    'assessment.focus_lost': 'focusLostCount',
    'assessment.pasted': 'pastedCount',
    'assessment.copied': 'copiedCount',
    'assessment.fullscreen_exited': 'fullscreenExitedCount',
};

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
    if (!CONTENT_VERBS[verb] && !OTHER_VERBS.has(verb) && !SIGNAL_VERBS[verb]) {
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

// What every assessment event names of its Assessment, as a Content's events name its
// type and ClassSubject, so a later report needs no join (assessment ticket 06).
const assessmentContextOf = (assessment) => ({
    assessmentType: assessment.type,
    mode: assessment.mode,
    classSubjectId: assessment.classSubject.id,
});

// One integrity signal on a Submission still in progress (assessment ticket 06): its
// count raised and its Learning Event written, in the caller's transaction. The
// raise is the claim - its where holds the Submission open - so a signal landing as
// the attempt is handed in, closed by time or voided records nothing and answers
// { recorded: false }. The caller has checked that the Submission is the Student's
// own and that its Assessment records signals.
async function recordSignal(client, { actorMembershipId, submission, verb, occurredAt }) {
    const raised = await client.submission.updateMany({
        where: { id: submission.id, submittedAt: null, voidedAt: null, deadlineAt: { gt: new Date() } },
        data: { [SIGNAL_VERBS[verb]]: { increment: 1 } },
    });
    if (raised.count === 0) return { recorded: false };

    await recordEvent(client, {
        actorMembershipId,
        verb,
        objectType: 'Submission',
        objectId: submission.id,
        context: { assessmentId: submission.assessment.id, ...assessmentContextOf(submission.assessment) },
        occurredAt,
    });
    return { recorded: true };
}

export {
    CONTENT_VERBS,
    CLIENT_VERBS,
    SIGNAL_VERBS,
    VIDEO_COMPLETE_AT,
    recordEvent,
    recordContentEvent,
    assessmentContextOf,
    recordSignal,
};
