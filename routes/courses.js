const express = require('express');
const db = require('../config/db');
const { verifyToken, authorizeRoles } = require('../authMiddleware');
const { validateCourse } = require('../validationMiddleware');
const { rewardXp } = require('../helpers/gamification');

const router = express.Router();

// Helper middleware to ensure school_id is present
const ensureSchoolAssociated = (req, res, next) => {
    if (!req.user || !req.user.school_id) {
        return res.status(403).json({ error: 'Akses ditolak. Akun Anda tidak terasosiasi dengan sekolah mana pun.' });
    }
    next();
};

// 1. Create Course (POST /api/courses)
router.post('/courses', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher', 'headmaster'), validateCourse, async (req, res) => {
    const { code, name, description, grade_level, teacher_id } = req.body;
    const school_id = req.user.school_id;

    try {
        let subjectId;
        const subjectRes = await db.query('SELECT id FROM subjects WHERE code = $1 AND school_id = $2', [code, school_id]);
        if (subjectRes.rows.length > 0) {
            subjectId = subjectRes.rows[0].id;
        } else {
            const newSubject = await db.query(
                'INSERT INTO subjects (school_id, code, name, description) VALUES ($1, $2, $3, $4) RETURNING id',
                [school_id, code, name, description || null]
            );
            subjectId = newSubject.rows[0].id;
        }

        let classId;
        const classRes = await db.query('SELECT id FROM classes WHERE name = $1 AND school_id = $2', [grade_level, school_id]);
        if (classRes.rows.length > 0) {
            classId = classRes.rows[0].id;
        } else {
            const newClass = await db.query('INSERT INTO classes (school_id, name) VALUES ($1, $2) RETURNING id', [school_id, grade_level]);
            classId = newClass.rows[0].id;
        }

        const insertQuery = `
            INSERT INTO class_subjects (class_id, subject_id, teacher_id)
            VALUES ($1, $2, $3)
            RETURNING id
        `;
        const result = await db.query(insertQuery, [classId, subjectId, teacher_id || null]);
        
        return res.status(201).json({
            message: 'Mata pelajaran berhasil ditambahkan.',
            course: {
                id: result.rows[0].id,
                code,
                name,
                grade_level,
                teacher_id
            }
        });
    } catch (err) {
        console.error('Create Course Error:', err);
        return res.status(500).json({ error: `Gagal menambahkan mata pelajaran: ${err.message}` });
    }
});

// 2. Read Courses (GET /api/courses)
router.get('/courses', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const school_id = req.user.school_id;
    const userId = req.user.id;
    const role = req.user.role;

    try {
        let query;
        let params;
        if (role === 'teacher') {
            query = `
                SELECT cs.id, s.name, s.code, c.name AS grade_level, cs.teacher_id,
                       COALESCE((SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = cs.class_id), 0) AS student_count
                FROM class_subjects cs
                JOIN classes c ON cs.class_id = c.id
                JOIN subjects s ON cs.subject_id = s.id
                WHERE c.school_id = $1 AND cs.teacher_id = $2
                ORDER BY cs.id DESC
            `;
            params = [school_id, userId];
        } else {
            query = `
                SELECT cs.id, s.name, s.code, c.name AS grade_level, cs.teacher_id,
                       COALESCE((SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = cs.class_id), 0) AS student_count
                FROM class_subjects cs
                JOIN classes c ON cs.class_id = c.id
                JOIN subjects s ON cs.subject_id = s.id
                WHERE c.school_id = $1
                ORDER BY cs.id DESC
            `;
            params = [school_id];
        }
        const result = await db.query(query, params);
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Courses Error:', err);
        return res.status(500).json({ error: `Gagal mengambil daftar mata pelajaran: ${err.message}` });
    }
});

// 3. Get Course Detail (GET /api/courses/:id)
router.get('/courses/:id', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const { id } = req.params;
    const school_id = req.user.school_id;

    try {
        const query = `
            SELECT cs.id, s.name, s.code, c.name AS grade_level, cs.teacher_id
            FROM class_subjects cs
            JOIN classes c ON cs.class_id = c.id
            JOIN subjects s ON cs.subject_id = s.id
            WHERE cs.id = $1 AND c.school_id = $2
        `;
        const result = await db.query(query, [id, school_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan.' });
        }
        return res.json(result.rows[0]);
    } catch (err) {
        console.error('Get Course Detail Error:', err);
        return res.status(500).json({ error: `Gagal mengambil detail mata pelajaran: ${err.message}` });
    }
});

// 4. Update Course (PUT /api/courses/:id)
router.put('/courses/:id', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher', 'headmaster'), validateCourse, async (req, res) => {
    const { id } = req.params;
    const { code, name, description, grade_level, teacher_id } = req.body;
    const school_id = req.user.school_id;

    try {
        const csCheck = await db.query(
            `SELECT cs.id, cs.class_id, cs.subject_id 
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.id = $1 AND c.school_id = $2`,
            [id, school_id]
        );
        if (csCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan di sekolah Anda.' });
        }

        const { class_id, subject_id } = csCheck.rows[0];

        await db.query(
            'UPDATE subjects SET name = $1, code = $2 WHERE id = $3',
            [name, code, subject_id]
        );

        await db.query(
            'UPDATE classes SET name = $1 WHERE id = $2',
            [grade_level, class_id]
        );

        await db.query(
            'UPDATE class_subjects SET teacher_id = $1 WHERE id = $2',
            [teacher_id || null, id]
        );

        return res.json({
            message: 'Mata pelajaran berhasil diperbarui.',
            course: {
                id,
                code,
                name,
                grade_level,
                teacher_id
            }
        });
    } catch (err) {
        console.error('Update Course Error:', err);
        return res.status(500).json({ error: `Gagal diperbarui: ${err.message}` });
    }
});

// 5. Delete Course (DELETE /api/courses/:id)
router.delete('/courses/:id', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const { id } = req.params;
    const school_id = req.user.school_id;

    try {
        const result = await db.query(
            `DELETE FROM class_subjects cs
             USING classes c
             WHERE cs.class_id = c.id AND cs.id = $1 AND c.school_id = $2
             RETURNING cs.id`,
            [id, school_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan di sekolah Anda.' });
        }

        return res.json({
            message: 'Mata pelajaran berhasil dihapus.',
            course: { id }
        });
    } catch (err) {
        console.error('Delete Course Error:', err);
        return res.status(500).json({ error: `Gagal menghapus: ${err.message}` });
    }
});

// 6. Get Course Students (GET /api/courses/:courseId/students)
router.get('/courses/:courseId/students', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const { courseId } = req.params;
    const school_id = req.user.school_id;

    try {
        const courseCheck = await db.query(
            `SELECT cs.id 
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.id = $1 AND c.school_id = $2`, 
            [courseId, school_id]
        );
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan.' });
        }

        const query = `
            SELECT u.id, u.username, u.email, u.name, u.nis, u.xp, u.level
            FROM users u
            JOIN class_enrollments ce ON u.id = ce.student_id
            JOIN class_subjects cs ON ce.class_id = cs.class_id
            WHERE cs.id = $1 AND u.role = 'student' AND u.school_id = $2
            ORDER BY u.name ASC
        `;
        const result = await db.query(query, [courseId, school_id]);
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Course Students Error:', err);
        return res.status(500).json({ error: `Gagal mengambil siswa: ${err.message}` });
    }
});

// 7. Get Course Assignments (GET /api/courses/:courseId/assignments)
router.get('/courses/:courseId/assignments', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const { courseId } = req.params;
    const school_id = req.user.school_id;

    try {
        const courseCheck = await db.query(
            `SELECT cs.id 
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.id = $1 AND c.school_id = $2`, 
            [courseId, school_id]
        );
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan.' });
        }

        let query;
        let params;
        const role = req.user.role;
        const userId = req.user.id;

        if (role === 'student') {
            query = `
                SELECT a.id, a.title, a.deadline, a.description, a.weight, a.xp_reward AS "xpReward",
                       CASE 
                         WHEN sub.id IS NOT NULL AND sub.status != 'Belum Mengumpulkan' THEN 'completed'
                         WHEN a.deadline < CURRENT_TIMESTAMP THEN 'late'
                         ELSE 'pending'
                       END AS status,
                       sub.grade
                FROM assessments a
                JOIN sessions sec ON a.session_id = sec.id
                LEFT JOIN assessment_submissions sub ON a.id = sub.assessment_id AND sub.student_id = $2
                WHERE sec.class_subject_id = $1 AND a.type = 'tugas'
                ORDER BY a.id DESC
            `;
            params = [courseId, userId];
        } else {
            query = `
                SELECT a.id, a.title, a.deadline, a.description, a.weight, a.xp_reward AS "xpReward",
                       (SELECT COUNT(*) FROM assessment_submissions s WHERE s.assessment_id = a.id AND s.status != 'Belum Mengumpulkan') AS "submittedCount",
                       (SELECT COUNT(DISTINCT ce.student_id) FROM class_enrollments ce JOIN class_subjects cs ON ce.class_id = cs.class_id WHERE cs.id = $1) AS "totalCount"
                FROM assessments a
                JOIN sessions sec ON a.session_id = sec.id
                WHERE sec.class_subject_id = $1 AND a.type = 'tugas'
                ORDER BY a.id DESC
            `;
            params = [courseId];
        }
        const result = await db.query(query, params);
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Course Assignments Error:', err);
        return res.status(500).json({ error: `Gagal mengambil daftar tugas: ${err.message}` });
    }
});

// 8. Create Course Assignment (POST /api/courses/:courseId/assignments)
router.post('/courses/:courseId/assignments', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const { courseId } = req.params;
    const { title, description, deadline } = req.body;
    const school_id = req.user.school_id;

    if (!title || !description || !deadline) {
        return res.status(400).json({ error: 'Judul, deskripsi, dan deadline wajib diisi.' });
    }

    try {
        const courseCheck = await db.query(
            `SELECT cs.id 
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.id = $1 AND c.school_id = $2`, 
            [courseId, school_id]
        );
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan.' });
        }

        let sessionId;
        const sessionRes = await db.query('SELECT id FROM sessions WHERE class_subject_id = $1 ORDER BY sequence_order ASC LIMIT 1', [courseId]);
        if (sessionRes.rows.length > 0) {
            sessionId = sessionRes.rows[0].id;
        } else {
            const insertSession = await db.query(
                "INSERT INTO sessions (class_subject_id, title, sequence_order) VALUES ($1, 'General / Pertemuan 1', 1) RETURNING id",
                [courseId]
            );
            sessionId = insertSession.rows[0].id;
        }

        const insertQuery = `
            INSERT INTO assessments (session_id, title, type, deadline, description, weight)
            VALUES ($1, $2, 'tugas', $3, $4, 0)
            RETURNING id, title, deadline, description, weight
        `;
        const result = await db.query(insertQuery, [sessionId, title, deadline, description]);
        
        // Find all students enrolled in this course class
        const studentsQuery = `
            SELECT ce.student_id 
            FROM class_enrollments ce
            JOIN class_subjects cs ON ce.class_id = cs.class_id
            WHERE cs.id = $1
        `;
        const enrolledStudents = await db.query(studentsQuery, [courseId]);

        // Get subject name
        const subjectRes = await db.query(
            `SELECT s.name 
             FROM class_subjects cs
             JOIN subjects s ON cs.subject_id = s.id
             WHERE cs.id = $1`,
            [courseId]
        );
        const subjectName = subjectRes.rows.length > 0 ? subjectRes.rows[0].name : 'Mata Pelajaran';

        const newAssignmentId = result.rows[0].id;

        // Create notification for each student
        for (const student of enrolledStudents.rows) {
            await db.query(`
                INSERT INTO notifications (school_id, user_id, title, message, type, link_path)
                VALUES ($1, $2, $3, $4, 'tugas_baru', $5)
            `, [
                school_id,
                student.student_id,
                'Tugas Baru Dipublikasikan',
                `Tugas baru "${title}" telah diposting di mata pelajaran ${subjectName}.`,
                `/assignment/${newAssignmentId}`
            ]);
        }

        return res.status(201).json({
            message: 'Tugas berhasil dibuat.',
            assignment: {
                ...result.rows[0],
                submittedCount: 0,
                totalCount: 35
            }
        });
    } catch (err) {
        console.error('Create Assignment Error:', err);
        return res.status(500).json({ error: `Gagal membuat tugas: ${err.message}` });
    }
});

// 9. Get Course Materials (GET /api/courses/:courseId/materials)
router.get('/courses/:courseId/materials', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const { courseId } = req.params;
    const school_id = req.user.school_id;

    try {
        const courseCheck = await db.query(
            `SELECT cs.id 
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.id = $1 AND c.school_id = $2`, 
            [courseId, school_id]
        );
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan.' });
        }

        const query = `
            SELECT m.id, m.title, m.type, m.size, m.description
            FROM materials m
            JOIN sessions sec ON m.session_id = sec.id
            WHERE sec.class_subject_id = $1
            ORDER BY m.id DESC
        `;
        const result = await db.query(query, [courseId]);
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Course Materials Error:', err);
        return res.status(500).json({ error: `Gagal mengambil materi: ${err.message}` });
    }
});

// 10. Create Course Material (POST /api/courses/:courseId/materials)
router.post('/courses/:courseId/materials', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const { courseId } = req.params;
    const { title, description, size } = req.body;
    const school_id = req.user.school_id;

    if (!title) {
        return res.status(400).json({ error: 'Judul materi wajib diisi.' });
    }

    try {
        const courseCheck = await db.query(
            `SELECT cs.id 
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.id = $1 AND c.school_id = $2`, 
            [courseId, school_id]
        );
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan.' });
        }

        let sessionId;
        const sessionRes = await db.query('SELECT id FROM sessions WHERE class_subject_id = $1 ORDER BY sequence_order ASC LIMIT 1', [courseId]);
        if (sessionRes.rows.length > 0) {
            sessionId = sessionRes.rows[0].id;
        } else {
            const insertSession = await db.query(
                "INSERT INTO sessions (class_subject_id, title, sequence_order) VALUES ($1, 'General / Pertemuan 1', 1) RETURNING id",
                [courseId]
            );
            sessionId = insertSession.rows[0].id;
        }

        const insertQuery = `
            INSERT INTO materials (session_id, title, type, size, description)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, title, type, size, description
        `;
        const result = await db.query(insertQuery, [sessionId, title, 'pdf', size || '2.0 MB', description || null]);

        return res.status(201).json({
            message: 'Materi berhasil diunggah.',
            material: result.rows[0]
        });
    } catch (err) {
        console.error('Create Material Error:', err);
        return res.status(500).json({ error: `Gagal mengunggah materi: ${err.message}` });
    }
});

// 11. Update Course Material (PUT /api/materials/:id)
router.put('/materials/:id', verifyToken, authorizeRoles('teacher'), async (req, res) => {
    const { id } = req.params;
    const { title, description } = req.body;

    if (!title) {
        return res.status(400).json({ error: 'Judul materi wajib diisi.' });
    }

    try {
        const query = `
            UPDATE materials 
            SET title = $1, description = $2 
            WHERE id = $3 
            RETURNING *
        `;
        const result = await db.query(query, [title, description || null, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Materi tidak ditemukan.' });
        }

        return res.json({
            message: 'Materi berhasil diperbarui.',
            material: result.rows[0]
        });
    } catch (err) {
        console.error('Update Material Error:', err);
        return res.status(500).json({ error: `Gagal memperbarui materi: ${err.message}` });
    }
});

// 12. Delete Course Material (DELETE /api/materials/:id)
router.delete('/materials/:id', verifyToken, authorizeRoles('teacher'), async (req, res) => {
    const { id } = req.params;

    try {
        const result = await db.query('DELETE FROM materials WHERE id = $1 RETURNING *', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Materi tidak ditemukan.' });
        }

        return res.json({
            message: 'Materi berhasil dihapus.',
            material: result.rows[0]
        });
    } catch (err) {
        console.error('Delete Material Error:', err);
        return res.status(500).json({ error: `Gagal menghapus materi: ${err.message}` });
    }
});

// 13. Get Course Members (GET /api/courses/:courseId/members)
router.get('/courses/:courseId/members', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const { courseId } = req.params;
    const school_id = req.user.school_id;

    try {
        const courseCheck = await db.query(
            `SELECT cs.teacher_id, u.name AS teacher_name, u.nip AS teacher_nip
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             JOIN users u ON cs.teacher_id = u.id
             WHERE cs.id = $1 AND c.school_id = $2`,
            [courseId, school_id]
        );
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan.' });
        }

        const teacherInfo = {
            name: courseCheck.rows[0].teacher_name,
            role: 'Guru Pengampu',
            nip: courseCheck.rows[0].teacher_nip || '—',
            avatar: courseCheck.rows[0].teacher_name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()
        };

        const studentsQuery = `
            SELECT u.id, u.name, u.email, u.nis
            FROM class_enrollments ce
            JOIN class_subjects cs ON ce.class_id = cs.class_id
            JOIN users u ON ce.student_id = u.id
            WHERE cs.id = $1 AND u.school_id = $2
            ORDER BY u.name ASC
        `;
        const studentsRes = await db.query(studentsQuery, [courseId, school_id]);

        return res.json({
            teacher: teacherInfo,
            classmates: studentsRes.rows.map(s => ({
                id: s.id,
                name: s.name,
                email: s.email,
                nis: s.nis,
                status: 'Siswa'
            }))
        });
    } catch (err) {
        console.error('Get Course Members Error:', err);
        return res.status(500).json({ error: `Gagal mengambil daftar anggota: ${err.message}` });
    }
});

// 14. Get Assignment Details & Student Submission (GET /api/assignments/:id)
router.get('/assignments/:id', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const { id } = req.params;
    const school_id = req.user.school_id;
    const userId = req.user.id;
    const role = req.user.role;

    try {
        const query = `
            SELECT a.id, a.title, a.type, a.deadline, a.xp_reward, a.description, a.weight,
                   s.name AS subject_name, s.code AS subject_code, c.name AS class_name, cs.id AS class_subject_id
            FROM assessments a
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN classes c ON cs.class_id = c.id
            JOIN subjects s ON cs.subject_id = s.id
            WHERE a.id = $1 AND c.school_id = $2
        `;
        const result = await db.query(query, [id, school_id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Penugasan tidak ditemukan.' });
        }

        const assignment = result.rows[0];
        let submission = null;
        let protest = null;

        if (role === 'student') {
            const subRes = await db.query(
                `SELECT id, submitted_at, file_url, file_name, grade, status, feedback
                 FROM assessment_submissions
                 WHERE assessment_id = $1 AND student_id = $2`,
                [id, userId]
            );
            if (subRes.rows.length > 0) {
                submission = subRes.rows[0];

                const protestRes = await db.query(
                    `SELECT id, reason, requested_grade, status, teacher_feedback, created_at
                     FROM grade_protests
                     WHERE submission_id = $1`,
                    [submission.id]
                );
                if (protestRes.rows.length > 0) {
                    protest = protestRes.rows[0];
                }
            }
        }

        return res.json({
            assignment,
            submission,
            protest
        });
    } catch (err) {
        console.error('Get Assignment Detail Error:', err);
        return res.status(500).json({ error: `Gagal memuat detail tugas: ${err.message}` });
    }
});

// 15. Submit Assignment (POST /api/assignments/:id/submit)
router.post('/assignments/:id/submit', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const { id } = req.params;
    const studentId = req.user.id;
    const { fileName } = req.body;

    try {
        const asmRes = await db.query('SELECT * FROM assessments WHERE id = $1', [id]);
        if (asmRes.rows.length === 0) {
            return res.status(404).json({ error: 'Penugasan tidak ditemukan.' });
        }

        const checkSub = await db.query(
            'SELECT id FROM assessment_submissions WHERE assessment_id = $1 AND student_id = $2',
            [id, studentId]
        );

        if (checkSub.rows.length > 0) {
            return res.status(400).json({ error: 'Anda sudah mengumpulkan tugas ini.' });
        }

        const query = `
            INSERT INTO assessment_submissions (assessment_id, student_id, file_name, file_url, status)
            VALUES ($1, $2, $3, $4, 'Belum Dinilai')
            RETURNING *
        `;
        const result = await db.query(query, [id, studentId, fileName || 'tugas_siswa.pdf', '', 'Belum Dinilai']);

        await rewardXp(studentId, 50, 'tugas_submit', id);

        return res.status(201).json({
            message: 'Tugas berhasil dikirim!',
            submission: result.rows[0],
            xpReward: 50
        });
    } catch (err) {
        console.error('Submit Assignment Error:', err);
        return res.status(500).json({ error: `Gagal mengirimkan tugas: ${err.message}` });
    }
});

// 16. Cancel Assignment Submission (DELETE /api/assignments/:id/cancel)
router.delete('/assignments/:id/cancel', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const { id } = req.params;
    const studentId = req.user.id;

    try {
        const subRes = await db.query(
            'SELECT id, grade FROM assessment_submissions WHERE assessment_id = $1 AND student_id = $2',
            [id, studentId]
        );

        if (subRes.rows.length === 0) {
            return res.status(404).json({ error: 'Pengumpulan tidak ditemukan.' });
        }

        if (subRes.rows[0].grade !== null) {
            return res.status(400).json({ error: 'Tugas sudah dinilai oleh guru dan tidak dapat dibatalkan.' });
        }

        const submissionId = subRes.rows[0].id;

        await db.query('DELETE FROM grade_protests WHERE submission_id = $1', [submissionId]);
        await db.query('DELETE FROM assessment_submissions WHERE id = $1', [submissionId]);

        await rewardXp(studentId, -50, 'tugas_batal', id);

        return res.json({ message: 'Pengumpulan tugas berhasil dibatalkan.' });
    } catch (err) {
        console.error('Cancel Submission Error:', err);
        return res.status(500).json({ error: `Gagal membatalkan pengumpulan: ${err.message}` });
    }
});

// 24. Delete Course / Class Subject Link (DELETE /api/courses/:id)
router.delete('/courses/:id', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const { id } = req.params;
    const school_id = req.user.school_id;

    try {
        // Verify class_subject belongs to this school
        const checkQuery = `
            SELECT cs.id 
            FROM class_subjects cs
            JOIN classes c ON cs.class_id = c.id
            WHERE cs.id = $1 AND c.school_id = $2
        `;
        const checkRes = await db.query(checkQuery, [id, school_id]);
        if (checkRes.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan atau Anda tidak memiliki akses.' });
        }

        // Delete from class_subjects
        await db.query('DELETE FROM class_subjects WHERE id = $1', [id]);

        return res.json({ message: 'Mata pelajaran berhasil dihapus.', id });
    } catch (err) {
        console.error('Delete Course Error:', err);
        return res.status(500).json({ error: `Gagal menghapus mata pelajaran: ${err.message}` });
    }
});

module.exports = router;
