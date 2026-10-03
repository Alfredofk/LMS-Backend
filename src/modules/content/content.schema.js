import { z } from 'zod';

// Content (teaching-and-learning ticket 04). Only the shape is checked here. Who
// may do what is the service's, and so are sanitising TEXT and reading a video
// link.

const id = z.string().min(1);

const idParams = z.object({ id });

const title = z.string().trim().min(1, 'Give it a title').max(200, 'Title is too long');

// VIDEO and LINK are links, and only https: a page opened from the school's LMS on
// a child's device is never plain http (ticket 04).
const httpsUrl = z
    .string()
    .trim()
    .max(2000, 'Link is too long')
    .refine((value) => {
        try {
            return new URL(value).protocol === 'https:';
        } catch {
            return false;
        }
    }, 'Use an https:// link');

// Rich text from the teacher's editor: HTML, sanitised by the service before it is
// stored. The limit is on what arrives.
const html = z.string().max(200_000, 'The text is too long');

// VIDEO, LINK and TEXT arrive as JSON. A FILE arrives as multipart (fileBody).
const createBody = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('VIDEO'), title, url: httpsUrl }),
    z.strictObject({ type: z.literal('LINK'), title, url: httpsUrl }),
    z.strictObject({ type: z.literal('TEXT'), title, html }),
]);

// A FILE: the file under `file`, and its title as a form field.
const fileBody = z.strictObject({ title });

// An edit: the title, and what the type holds - a link for VIDEO and LINK, the text
// for TEXT. A FILE's file is not replaced: delete it and add another.
const patchBody = z
    .strictObject({ title: title.optional(), url: httpsUrl.optional(), html: html.optional() })
    .refine((value) => Object.values(value).some((field) => field !== undefined), 'Nothing to change');

// A Session's Content in its new order: every one still there, each once.
const orderBody = z.strictObject({ contentIds: z.array(id).min(1).max(200) });

export { idParams, createBody, fileBody, patchBody, orderBody };
