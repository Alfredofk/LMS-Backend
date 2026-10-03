import sanitizeHtml from 'sanitize-html';

import { prisma } from '../../shared/prisma.js';
import { isPrincipalOrVice, isHomeroomOf } from '../../shared/guards.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { getStorage } from '../../shared/storage.js';
import { MIME } from '../../shared/upload.js';
import { createLogger } from '../../lib/helpers.js';
import { answeringTeacherOf } from '../sessions/sessions.service.js';

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
//   shown to children. No scripts, no styles, links and images https only.
// - LINK: an https link.
// - Deleting is soft (handoff #26): deletedAt, and a FILE's bytes stay.
// - A Session cancelled for a holiday hands its Content on: content.moves.js, called
//   from sessions.service.js.
//
// Ticket 05 (Learning Events) writes content.published at the point marked below.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_TYPES = ['pdf', 'jpg', 'png', 'docx', 'pptx'];
// What a browser shows itself; the rest it downloads.
const INLINE_TYPES = new Set(['pdf', 'jpg', 'png']);

const sessionSelect = {
    id: true,
    number: true,
    status: true,
    cancelReason: true,
    startsAt: true,
    endsAt: true,
    classSubject: {
        select: {
            id: true,
            status: true,
            endedAt: true,
            classId: true,
            subjectId: true,
            semesterId: true,
            teacherMembershipId: true,
            class: { select: { name: true } },
            subject: { select: { code: true, name: true } },
        },
    },
};

const describe = (session) =>
    `Pertemuan ke-${session.number} of ${session.classSubject.subject.code} in ${session.classSubject.class.name}`;

async function loadSession(id) {
    const session = await prisma.session.findFirst({ where: { id }, select: sessionSelect });
    if (!session) throw notFound('Session not found');
    return session;
}

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
// - 'staff': the Principal, a Vice Principal, the Class's homeroom teacher - they
//   read all of it, drafts included;
// - 'student': placed in the Class now - reads what is published;
// - null: anyone else, another school included, who gets a 404.
async function standingOf(auth, session) {
    if ((await answeringTeacherOf(session.classSubject)) === auth.membershipId) return 'teacher';
    if (await isPrincipalOrVice(auth.membershipId)) return 'staff';
    if (await isHomeroomOf(auth.membershipId, session.classSubject.classId)) return 'staff';

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

// Staff who may read are told no (403); anyone the Session does not concern gets
// the same 404 as another school's.
async function assertManages(auth, session) {
    const standing = await standingOf(auth, session);
    if (standing === 'teacher') return;
    if (standing === null || standing === 'student') throw notFound('Session not found');
    throw forbidden('Only the teacher of this class subject manages its content');
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

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// A FILE's storage key stays here; the bytes come from GET /api/content/:id/file.
function payloadView(type, payload) {
    if (type === 'FILE') {
        return { fileName: payload.fileName, fileType: payload.fileType, mimeType: payload.mimeType, size: payload.size };
    }
    if (type === 'VIDEO') return { url: payload.url, provider: payload.provider, videoId: payload.videoId };
    if (type === 'TEXT') return { html: payload.html };
    return { url: payload.url };
}

const contentView = (row) => ({
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    title: row.title,
    order: row.order,
    published: row.publishedAt !== null,
    publishedAt: row.publishedAt,
    payload: payloadView(row.type, row.payload),
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
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
    return { session: sessionView(session), canManage: standing === 'teacher', contents: rows.map(contentView) };
}

// A FILE's bytes. A student reaches only a published one; to anyone else it does
// not exist.
async function readFile(auth, contentId) {
    const row = await loadContent(contentId);
    const standing = await standingOf(auth, await loadSession(row.sessionId));
    if (!standing || (standing === 'student' && !row.publishedAt)) throw notFound('Content not found');
    if (row.type !== 'FILE') throw badRequest(`This content is a ${row.type}, not a file`);

    const buffer = await getStorage().read(row.payload.storageKey);
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
        throw conflict(`${describe(session)} was cancelled; add the content to another Pertemuan`);
    }
    return session;
}

async function nextOrder(sessionId) {
    const last = await prisma.content.aggregate({
        where: { sessionId, deletedAt: null },
        _max: { order: true },
    });
    return (last._max.order ?? 0) + 1;
}

function payloadFor({ type, url, html }) {
    if (type === 'VIDEO') return videoPayload(url);
    if (type === 'TEXT') return { html: cleanText(html) };
    return { url };
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
    log.info(`${body.type} added to ${describe(session)}`);
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
    log.info(`FILE (${type.toUpperCase()}) added to ${describe(session)}`);
    return contentView(row);
}

async function update(auth, contentId, { title, url, html }) {
    const row = await loadContent(contentId);
    const session = await loadSession(row.sessionId);
    await assertManages(auth, session);

    const data = {};
    if (title !== undefined) data.title = title;
    if (url !== undefined) {
        if (row.type !== 'VIDEO' && row.type !== 'LINK') throw badRequest(`A ${row.type} has no link to change`);
        data.payload = row.type === 'VIDEO' ? videoPayload(url) : { url };
    }
    if (html !== undefined) {
        if (row.type !== 'TEXT') throw badRequest(`A ${row.type} has no text to change`);
        data.payload = { html: cleanText(html) };
    }

    const changed = await prisma.content.updateMany({ where: { id: row.id, deletedAt: null }, data });
    if (changed.count === 0) throw notFound('Content not found');
    log.info(`${row.type} edited in ${describe(session)}`);
    return contentView(await prisma.content.findFirst({ where: { id: row.id } }));
}

// Once only: published is published. To take one back, delete it.
async function publish(auth, contentId) {
    const row = await loadContent(contentId);
    const session = await loadSession(row.sessionId);
    await assertManages(auth, session);
    if (row.publishedAt) throw conflict('This content is published already');

    const claimed = await prisma.content.updateMany({
        where: { id: row.id, publishedAt: null, deletedAt: null },
        data: { publishedAt: new Date() },
    });
    if (claimed.count === 0) throw conflict('This content is published already');
    // Ticket 05: content.published.

    log.info(`${row.type} published in ${describe(session)}`);
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
        throw badRequest(`Name every content of ${describe(session)}, each once`);
    }

    await prisma.$transaction(async (tx) => {
        for (const [index, id] of contentIds.entries()) {
            await tx.content.updateMany({ where: { id, sessionId }, data: { order: index + 1 } });
        }
    });
    log.info(`Content reordered in ${describe(session)}`);
    return listForSession(auth, sessionId);
}

// Soft: the row stays with deletedAt, and a FILE's bytes stay in storage.
async function remove(auth, contentId) {
    const row = await loadContent(contentId);
    const session = await loadSession(row.sessionId);
    await assertManages(auth, session);

    const removed = await prisma.content.updateMany({
        where: { id: row.id, deletedAt: null },
        data: { deletedAt: new Date() },
    });
    if (removed.count === 0) throw notFound('Content not found');
    log.info(`${row.type} deleted from ${describe(session)}`);
}

export {
    MAX_FILE_BYTES,
    FILE_TYPES,
    listForSession,
    readFile,
    create,
    createFile,
    update,
    publish,
    reorder,
    remove,
};
