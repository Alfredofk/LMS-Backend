import { Router } from 'express';

import { requireAuth, requireActiveMembership, requireRole } from '../../shared/auth.js';
import { validate } from '../../shared/validate.js';
import { singleFile } from '../../shared/upload.js';
import * as controller from './content.controller.js';
import { MAX_FILE_BYTES, FILE_TYPES } from './content.service.js';
import { idParams, createBody, fileBody, patchBody, orderBody } from './content.schema.js';

// Mounted at /api/content (teaching-and-learning ticket 04).
//
// The teacher who answers for a Session adds its Content, edits, orders, publishes
// and deletes it. The school's leaders and the Class's homeroom teacher read it all;
// the Class's students read what is published, and download a file through
// /:id/file. requireRole('TEACHER') is the coarse filter on the writes only; the two
// reads have none. The service decides whose Session it is and answers 404 to
// anyone it does not concern - a guardian reading included.

const router = Router();

const teacher = requireRole('TEACHER');
const fileUpload = singleFile('file', { maxBytes: MAX_FILE_BYTES, types: FILE_TYPES });

router.use(requireAuth, requireActiveMembership);

router.get('/sessions/:id', validate({ params: idParams }), controller.listForSession);
router.post('/sessions/:id', teacher, validate({ params: idParams, body: createBody }), controller.create);
// The upload sits after the role check, so a caller who is no teacher is refused
// before the file is read.
router.post(
    '/sessions/:id/file',
    teacher,
    fileUpload,
    validate({ params: idParams, body: fileBody }),
    controller.createFile
);
router.put('/sessions/:id/order', teacher, validate({ params: idParams, body: orderBody }), controller.reorder);

router.get('/:id/file', validate({ params: idParams }), controller.readFile);
router.patch('/:id', teacher, validate({ params: idParams, body: patchBody }), controller.update);
router.post('/:id/publish', teacher, validate({ params: idParams }), controller.publish);
router.delete('/:id', teacher, validate({ params: idParams }), controller.remove);

export default router;
