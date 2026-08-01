const express = require('express');
const db = require('../config/db');
const { verifyToken } = require('../authMiddleware');

const router = express.Router();

const ensureSchoolAssociated = (req, res, next) => {
    if (!req.user || !req.user.school_id) {
        return res.status(403).json({ error: 'Akses ditolak. Akun Anda tidak terasosiasi dengan sekolah.' });
    }
    next();
};

// 1. Get Student Consolidated Assessments List (GET /api/assessment/student)
router.get('/student', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const studentId = req.user.id;

    try {
        const query = `
            SELECT a.id AS "assessmentId", a.title, a.deadline, a.xp_reward AS "xpReward", a.description,
                   s.name AS "subjectName", s.code AS "subjectCode",
                   sub.id AS "submissionId", COALESCE(sub.status, 'Belum Mengumpulkan') AS "submissionStatus", 
                   sub.grade, sub.feedback, sub.submitted_at AS "submittedAt"
            FROM assessments a
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN class_enrollments ce ON cs.class_id = ce.class_id
            LEFT JOIN assessment_submissions sub ON a.id = sub.assessment_id AND sub.student_id = $1
            WHERE ce.student_id = $1 AND a.type = 'tugas'
            ORDER BY a.deadline ASC
        `;
        const result = await db.query(query, [studentId]);
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Consolidated Assessments Error:', err);
        return res.status(500).json({ error: `Gagal mengambil daftar tugas siswa: ${err.message}` });
    }
});

module.exports = router;
