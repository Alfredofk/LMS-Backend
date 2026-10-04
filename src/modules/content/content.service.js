import sanitizeHtml from 'sanitize-html';

import { prisma } from '../../shared/prisma.js';
import { isPrincipalOrVice, isHomeroomOf } from '../../shared/guards.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { getStorage } from '../../shared/storage.js';
import { MIME } from '../../shared/upload.js';
import { createLogger } from '../../lib/helpers.js';
import { answeringTeacherOf, loadSession, describeSession } from '../sessions/sessions.service.js';
import { recordEvent, recordContentEvent } from '../tracking/tracking.record.js';
import { CONTENT_ORDER, lastOrderOf } from './content.moves.js';

const log = createLogger('Content');

// Content under a Session (teaching-and-learning ticket 04, handoff #13): FILE,
// VIDEO, TEXT or LINK, in an order, with no prerequisite gating.
//
// Owner's decisions (2026-09-27, 2026-09-28 and 2026-10-02):
// - The teacher who answers for the Session manages its Content: its ClassSubject's
//   own teacher, or the successor once that ended (answeringTeacherOf).
// - A draft until the teacher publishes it. Students see only what is published;
//   the Principal, Vice Principals and the homeroom teacher see drafts too.
// - A student reads the Content of their current Class only (spec invariant 6), a
//   cancelled Session's included.
// - FILE: PDF, JPG, PNG, DOCX or PPTX, up to 10 MB, the type read from the bytes.
//   Stored under content/<schoolId>/; the storage key never leaves the server, and
//   the file is read back through a route that checks access.
// - VIDEO: an https link. A YouTube one keeps its video id for the frontend's
//   player (ticket 05 tracks how far it was watched); another site's is kept as a
//   link.
// - TEXT: HTML from the teacher's editor, sanitised before it is stored - it is
//   shown to children. No scripts, no styles; a link is https or mailto, an image
//   https. sanitize-html judges only an address that names a scheme, so a relative
//   one ("/x") stays - it can reach nothing but the page's own site.
// - LINK: an https link.
// - Deleting is soft (handoff #26): deletedAt, and a FILE's bytes stay.
// - A Session cancelled for a holiday hands its Content on: content.moves.js, called
//   from sessions.service.js.
//
// Learning Events (ticket 05): publishing writes content.published, and a student
// fetching a FILE writes content.file_downloaded - observed by the server, not
// claimed by the client. readableByStudent is what the tracking module asks before
// it records a student's own events.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_TYPES = ['pdf', 'jpg', 'png', 'docx', 'pptx'];
// What a browser shows itself; the rest it downloads.
const INLINE_TYPES = new Set(['pdf', 'jpg', 'png']);

async function loadContent(id) {
    const row = await prisma.content.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw notFound('Content not found');
    return row;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

// What a caller is to a Session's Content:
// - 'teacher': the one who answers for the Session, and manages its Content;
// - 'reader': the Principal, a Vice Principal, the Class's homeroom teacher - they
//   read all of it, drafts included, and write none of it;
// - 'student': placed in the Class now - reads what is published;
// - null: anyone else, another school included, who gets a 404.
async function standingOf(auth, session) {
    if ((await answeringTeacherOf(session.classSubject)) === auth.membershipId) return 'teacher';
    if (await isPrincipalOrVice(auth.membershipId)) return 'reader';
    if (await isHomeroomOf(auth.membershipId, session.classSubject.classId)) return 'reader';

    const placed = await prisma.classMembership.findFirst({
        where: {
            classId: session.classSubject.classId,
            endedAt: null,
            studentProfile: { membershipId: auth.membershipId, endedAt: null },
        },
        select: { id: true },
    });
    return placed ? 'student' : null;
}

// A reader is told no (403); anyone the Session does not concern gets the same 404
// as another school's.
async function assertManages(auth, session) {
    const standing = await standingOf(auth, session);
    if (standing === 'teacher') return;
    if (standing === null || standing === 'student') throw notFound('Session not found');
    throw forbidden('Only the teacher of this class subject manages its content');
}

// A live Content and its Session, for the teacher who manages it.
async function loadManagedContent(auth, contentId) {
    const row = await loadContent(contentId);
    const session = await loadSession(row.sessionId);
    await assertManages(auth, session);
    return { row, session };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const TEXT_RULES = {
    allowedTags: [
        'p', 'br', 'hr', 'span',
        'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
        'h1', 'h2', 'h3', 'h4',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
        'a', 'img',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
        a: ['href', 'target', 'rel'],
        img: ['src', 'alt', 'width', 'height'],
        th: ['colspan', 'rowspan'],
        td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['https'],
    allowedSchemesByTag: { a: ['https', 'mailto'] },
    allowProtocolRelative: false,
    // A link opens away from the LMS, and the page it opens gets no handle on it.
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
};

function cleanText(html) {
    const clean = sanitizeHtml(html, TEXT_RULES).trim();
    const words = sanitizeHtml(clean, { allowedTags: [], allowedAttributes: {} }).trim();
    if (!words && !clean.includes('<img')) throw badRequest('The text is empty');
    return clean;
}

const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com',
]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

// youtu.be/ID, youtube.com/watch?v=ID, /shorts/ID, /embed/ID or /live/ID. A YouTube
// page that is not one video - a channel, a playlist - is refused rather than kept
// as a link no player can follow.
function videoPayload(url) {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isYouTube = host === 'youtu.be' || YOUTUBE_HOSTS.has(host);
    if (!isYouTube) return { url, provider: 'OTHER', videoId: null };

    const [, first, second] = parsed.pathname.split('/');
    let videoId = null;
    if (host === 'youtu.be') videoId = first;
    else if (first === 'watch') videoId = parsed.searchParams.get('v');
    else if (['shorts', 'embed', 'live'].includes(first)) videoId = second;

    if (!videoId || !YOUTUBE_ID.test(videoId)) throw badRequest('That YouTube link is not a single video');
    return { url, provider: 'YOUTUBE', videoId };
}

// The uploaded name, kept for the download, never for the stored key. Its folder
// part and control characters go, and it ends in the type the bytes showed.
function fileNameOf(original, type) {
    const base = (original ?? '')
        .split(/[\\/]/)
        .pop()
        .replace(/[\u0000-\u001f"]/g, '')
        .trim()
        .slice(0, 150);
    const name = base || 'file';
    const extensions = type === 'jpg' ? ['.jpg', '.jpeg'] : [`.${type}`];
    return extensions.some((ext) => name.toLowerCase().endsWith(ext)) ? name : `${name}.${type}`;
}

// What differs by type, in one place:
// - view: the payload as a response shows it. A FILE's storage key stays here; the
//   bytes come from GET /api/content/:id/file.
// - fromUrl / fromHtml: the payload made from what a body sends, for the types
//   that hold a link or a text. A FILE has neither: it arrives as multipart, and
//   its file is not replaced.
const TYPES = {
    FILE: {
        view: (payload) => ({
            fileName: payload.fileName,
            fileType: payload.fileType,
            mimeType: payload.mimeType,
            size: payload.size,
        }),
    },
    VIDEO: {
        view: (payload) => ({ url: payload.url, provider: payload.provider, videoId: payload.videoId }),
        fromUrl: videoPayload,
    },
    TEXT: {
        view: (payload) => ({ html: payload.html }),
        fromHtml: (html) => ({ html: cleanText(html) }),
    },
    LINK: {
        view: (payload) => ({ url: payload.url }),
        fromUrl: (url) => ({ url }),
    },
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const contentView = (row) => ({
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    title: row.title,
    order: row.order,
    published: row.publishedAt !== null,
    publishedAt: row.publishedAt,
    payload: TYPES[row.type].view(row.payload),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const sessionView = (session) => ({
    id: session.id,
    number: session.number,
    status: session.status,
    cancelReason: session.cancelReason,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    class: session.classSubject.class.name,
    subject: session.classSubject.subject,
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function listForSession(auth, sessionId) {
    const session = await loadSession(sessionId);
    const standing = await standingOf(auth, session);
    if (!standing) throw notFound('Session not found');

    const rows = await prisma.content.findMany({
        where: {
            sessionId,
            deletedAt: null,
            ...(standing === 'student' ? { publishedAt: { not: null } } : {}),
        },
        orderBy: CONTENT_ORDER,
    });
    return { session: sessionView(session), canManage: standing === 'teacher', contents: rows.map(contentView) };
}

// A Content a student may act on: live, published, under a Session of the Class
// they sit in now - what listForSession shows them (spec invariant 6). Null for
// anything else, another school's included, so the caller answers every miss
// alike.
async function readableByStudent(auth, contentId) {
    const row = await prisma.content.findFirst({
        where: { id: contentId, deletedAt: null, publishedAt: { not: null } },
    });
    if (!row) return null;
    const session = await loadSession(row.sessionId);
    return (await standingOf(auth, session)) === 'student' ? { content: row, session } : null;
}

// The student whose standing let them in, for their progress row.
async function studentProfileOf(auth) {
    const profile = await prisma.studentProfile.findFirst({
        where: { membershipId: auth.membershipId, endedAt: null },
        select: { id: true },
    });
    return profile?.id ?? null;
}

// A FILE's bytes. A student reaches only a published one; to anyone else it does
// not exist.
//
// A student's fetch is recorded as content.file_downloaded once the bytes are read
// (ticket 05), and completes the FILE. A staff member's is not tracked.
async function readFile(auth, contentId) {
    const row = await loadContent(contentId);
    const session = await loadSession(row.sessionId);
    const standing = await standingOf(auth, session);
    if (!standing || (standing === 'student' && !row.publishedAt)) throw notFound('Content not found');
    if (row.type !== 'FILE') throw badRequest(`This content is a ${row.type}, not a file`);

    const buffer = await getStorage().read(row.payload.storageKey);
    if (standing === 'student') {
        const studentProfileId = await studentProfileOf(auth);
        await prisma.$transaction((tx) =>
            recordContentEvent(tx, {
                actorMembershipId: auth.membershipId,
                studentProfileId,
                content: row,
                session,
                verb: 'content.file_downloaded',
                occurredAt: new Date(),
            })
        );
    }
    return {
        buffer,
        contentType: row.payload.mimeType,
        fileName: row.payload.fileName,
        inline: INLINE_TYPES.has(row.payload.fileType),
    };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// Content goes to a Session still to be taught or taught already; a cancelled one
// takes none (its own moved on, if a holiday cancelled it).
async function loadForWriting(auth, sessionId) {
    const session = await loadSession(sessionId);
    await assertManages(auth, session);
    if (session.status !== 'SCHEDULED') {
        throw conflict(`${describeSession(session)} was cancelled; add the content to another Session`);
    }
    return session;
}

const nextOrder = async (sessionId) => (await lastOrderOf(prisma, sessionId)) + 1;

// VIDEO, LINK or TEXT from the JSON body; the schema lets no FILE through.
function payloadFor({ type, url, html }) {
    const { fromUrl, fromHtml } = TYPES[type];
    return fromHtml ? fromHtml(html) : fromUrl(url);
}

async function create(auth, sessionId, body) {
    const session = await loadForWriting(auth, sessionId);
    const payload = payloadFor(body);
    const row = await prisma.content.create({
        data: {
            sessionId,
            type: body.type,
            title: body.title,
            order: await nextOrder(sessionId),
            payload,
            createdByUserId: auth.userId,
        },
    });
    log.info(`${body.type} added to ${describeSession(session)}`);
    return contentView(row);
}

// Everything that can refuse is checked before the file is written; a failure
// after it removes the file again, as the KTP and letter uploads do.
async function createFile(auth, sessionId, { title }, file) {
    const session = await loadForWriting(auth, sessionId);
    const type = file.detectedType;
    const storage = getStorage();
    const storageKey = await storage.save(file.buffer, {
        folder: `content/${auth.schoolId}`,
        originalName: `upload.${type}`,
    });

    let row;
    try {
        row = await prisma.content.create({
            data: {
                sessionId,
                type: 'FILE',
                title,
                order: await nextOrder(sessionId),
                payload: {
                    storageKey,
                    fileName: fileNameOf(file.originalname, type),
                    fileType: type,
                    mimeType: MIME[type],
                    size: file.size,
                },
                createdByUserId: auth.userId,
            },
        });
    } catch (error) {
        await storage.remove(storageKey);
        throw error;
    }
    log.info(`FILE (${type.toUpperCase()}) added to ${describeSession(session)}`);
    return contentView(row);
}

async function update(auth, contentId, { title, url, html }) {
    const { row, session } = await loadManagedContent(auth, contentId);
    const { fromUrl, fromHtml } = TYPES[row.type];

    const data = {};
    if (title !== undefined) data.title = title;
    if (url !== undefined) {
        if (!fromUrl) throw badRequest(`A ${row.type} has no link to change`);
        data.payload = fromUrl(url);
    }
    if (html !== undefined) {
        if (!fromHtml) throw badRequest(`A ${row.type} has no text to change`);
        data.payload = fromHtml(html);
    }

    const changed = await prisma.content.updateMany({ where: { id: row.id, deletedAt: null }, data });
    if (changed.count === 0) throw notFound('Content not found');
    log.info(`${row.type} edited in ${describeSession(session)}`);
    return contentView(await prisma.content.findFirst({ where: { id: row.id } }));
}

// Once only: published is published. To take one back, delete it.
async function publish(auth, contentId) {
    const { row, session } = await loadManagedContent(auth, contentId);
    if (row.publishedAt) throw conflict('This content is published already');

    const now = new Date();
    await prisma.$transaction(async (tx) => {
        const claimed = await tx.content.updateMany({
            where: { id: row.id, publishedAt: null, deletedAt: null },
            data: { publishedAt: now },
        });
        if (claimed.count === 0) throw conflict('This content is published already');

        await recordEvent(tx, {
            actorMembershipId: auth.membershipId,
            verb: 'content.published',
            objectType: 'Content',
            objectId: row.id,
            context: { contentType: row.type, sessionId: row.sessionId, classSubjectId: session.classSubject.id },
            occurredAt: now,
        });
    });

    log.info(`${row.type} published in ${describeSession(session)}`);
    return contentView(await prisma.content.findFirst({ where: { id: row.id } }));
}

// A Session's Content in a new order: every live one named, each once.
async function reorder(auth, sessionId, { contentIds }) {
    const session = await loadSession(sessionId);
    await assertManages(auth, session);

    const live = await prisma.content.findMany({ where: { sessionId, deletedAt: null }, select: { id: true } });
    const liveIds = new Set(live.map((row) => row.id));
    if (new Set(contentIds).size !== contentIds.length) throw badRequest('A content is named twice');
    if (contentIds.length !== liveIds.size || !contentIds.every((id) => liveIds.has(id))) {
        throw badRequest(`Name every content of ${describeSession(session)}, each once`);
    }

    await prisma.$transaction(async (tx) => {
        for (const [index, id] of contentIds.entries()) {
            await tx.content.updateMany({ where: { id, sessionId }, data: { order: index + 1 } });
        }
    });
    log.info(`Content reordered in ${describeSession(session)}`);
    return listForSession(auth, sessionId);
}

// Soft: the row stays with deletedAt, and a FILE's bytes stay in storage.
async function remove(auth, contentId) {
    const { row, session } = await loadManagedContent(auth, contentId);

    const removed = await prisma.content.updateMany({
        where: { id: row.id, deletedAt: null },
        data: { deletedAt: new Date() },
    });
    if (removed.count === 0) throw notFound('Content not found');
    log.info(`${row.type} deleted from ${describeSession(session)}`);
}

export {
    MAX_FILE_BYTES,
    FILE_TYPES,
    listForSession,
    readFile,
    readableByStudent,
    studentProfileOf,
    create,
    createFile,
    update,
    publish,
    reorder,
    remove,
};
