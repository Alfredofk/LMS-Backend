const express = require('express');
const db = require('../config/db');
const { verifyToken, authorizeRoles } = require('../authMiddleware');

const router = express.Router();

const ensureSchoolAssociated = (req, res, next) => {
    if (!req.user || !req.user.school_id) {
        return res.status(403).json({ error: 'Akses ditolak. Akun Anda tidak terasosiasi dengan sekolah mana pun.' });
    }
    next();
};

// 1. Get School Announcements (GET /api/announcements)
router.get('/', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const schoolId = req.user.school_id;

    try {
        const query = `
            SELECT a.id, a.title, a.content, a.created_at, u.name as author_name
            FROM announcements a
            LEFT JOIN users u ON a.author_id = u.id
            WHERE a.school_id = $1
            ORDER BY a.id DESC
        `;
        const result = await db.query(query, [schoolId]);
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Announcements Error:', err);
        return res.status(500).json({ error: `Gagal mengambil pengumuman: ${err.message}` });
    }
});

// 2. Create Announcement (POST /api/announcements)
router.post('/', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const schoolId = req.user.school_id;
    const authorId = req.user.id;
    const { title, content } = req.body;

    if (!title || !content) {
        return res.status(400).json({ error: 'Judul dan isi pengumuman wajib diisi.' });
    }

    try {
        const query = `
            INSERT INTO announcements (school_id, title, content, author_id)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `;
        const result = await db.query(query, [schoolId, title, content, authorId]);
        
        // Find all users (teachers and students) in this school (excluding the headmaster themselves)
        const schoolUsersRes = await db.query(
            "SELECT id FROM users WHERE school_id = $1 AND id != $2 AND role IN ('student', 'teacher')",
            [schoolId, authorId]
        );

        // Insert notification for each user
        for (const targetUser of schoolUsersRes.rows) {
            await db.query(`
                INSERT INTO notifications (school_id, user_id, title, message, type, link_path)
                VALUES ($1, $2, $3, $4, 'pengumuman', $5)
            `, [
                schoolId,
                targetUser.id,
                'Pengumuman Baru Sekolah',
                `Kepala Sekolah menerbitkan pengumuman: "${title}".`,
                'pengumuman',
                '/announcements'
            ]);
        }

        return res.status(201).json({
            message: 'Pengumuman sekolah berhasil diterbitkan.',
            announcement: result.rows[0]
        });
    } catch (err) {
        console.error('Create Announcement Error:', err);
        return res.status(500).json({ error: `Gagal membuat pengumuman: ${err.message}` });
    }
});

// 3. Delete Announcement (DELETE /api/announcements/:id)
router.delete('/:id', verifyToken, ensureSchoolAssociated, authorizeRoles('headmaster'), async (req, res) => {
    const { id } = req.params;
    const schoolId = req.user.school_id;

    try {
        const result = await db.query(
            "DELETE FROM announcements WHERE id = $1 AND school_id = $2 RETURNING id",
            [id, schoolId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Pengumuman tidak ditemukan atau Anda tidak berwenang.' });
        }

        return res.json({ message: 'Pengumuman berhasil dihapus.', id });
    } catch (err) {
        console.error('Delete Announcement Error:', err);
        return res.status(500).json({ error: `Gagal menghapus pengumuman: ${err.message}` });
    }
});

// 4. Get Student Live Dashboard Widgets (GET /api/announcements/student/dashboard-widgets)
router.get('/student/dashboard-widgets', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const studentId = req.user.id;

    try {
        // Query A: Active Assessments (Tasks with upcoming deadlines that student has NOT submitted yet)
        const activeAssessmentsQuery = `
            SELECT a.id, a.title, a.deadline, s.name AS subject_name, cs.id AS class_subject_id
            FROM assessments a
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN class_enrollments ce ON cs.class_id = ce.class_id
            LEFT JOIN assessment_submissions sub ON a.id = sub.assessment_id AND sub.student_id = $1
            WHERE ce.student_id = $1 AND a.type = 'tugas' AND sub.id IS NULL AND a.deadline >= CURRENT_TIMESTAMP
            ORDER BY a.deadline ASC
            LIMIT 5
        `;
        const activeAssessmentsRes = await db.query(activeAssessmentsQuery, [studentId]);

        // Query B: Course progress (Submitted tasks vs total tasks per course)
        const courseProgressQuery = `
            SELECT cs.id AS class_subject_id, sub.name AS subject_name, sub.code AS subject_code,
                   COALESCE((
                       SELECT COUNT(*) FROM assessments a
                       JOIN sessions s ON a.session_id = s.id
                       WHERE s.class_subject_id = cs.id AND a.type = 'tugas'
                   ), 0) AS total_tasks,
                   COALESCE((
                       SELECT COUNT(*) FROM assessment_submissions asub
                       JOIN assessments a ON asub.assessment_id = a.id
                       JOIN sessions s ON a.session_id = s.id
                       WHERE s.class_subject_id = cs.id AND a.type = 'tugas' AND asub.student_id = $1 AND asub.status != 'Belum Mengumpulkan'
                   ), 0) AS submitted_tasks
            FROM class_enrollments ce
            JOIN class_subjects cs ON ce.class_id = cs.class_id
            JOIN subjects sub ON cs.subject_id = sub.id
            WHERE ce.student_id = $1
            ORDER BY sub.name ASC
        `;
        const courseProgressRes = await db.query(courseProgressQuery, [studentId]);

        return res.json({
            activeAssessments: activeAssessmentsRes.rows,
            courseProgress: courseProgressRes.rows
        });
    } catch (err) {
        console.error('Get Student Dashboard Widgets Error:', err);
        return res.status(500).json({ error: `Gagal memuat widget dasbor: ${err.message}` });
    }
});

module.exports = router;
