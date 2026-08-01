const express = require('express');
const db = require('../config/db');
const { verifyToken, authorizeRoles } = require('../authMiddleware');
const { rewardXp } = require('../helpers/gamification');

const router = express.Router();

const ensureSchoolAssociated = (req, res, next) => {
    if (!req.user || !req.user.school_id) {
        return res.status(403).json({ error: 'Akses ditolak. Akun Anda tidak terasosiasi dengan sekolah mana pun.' });
    }
    next();
};

// 1. Create Grade Protest (POST /api/protests)
router.post('/', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const studentId = req.user.id;
    const { submissionId, reason, requestedGrade } = req.body;

    if (!submissionId || !reason || requestedGrade === undefined) {
        return res.status(400).json({ error: 'Semua kolom input (submissionId, alasan, nilai harapan) wajib diisi.' });
    }

    try {
        const subCheck = await db.query(
            'SELECT id, grade FROM assessment_submissions WHERE id = $1 AND student_id = $2',
            [submissionId, studentId]
        );

        if (subCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Data pengumpulan tugas tidak ditemukan.' });
        }

        if (subCheck.rows[0].grade === null) {
            return res.status(400).json({ error: 'Anda tidak dapat menyanggah tugas yang belum dinilai oleh guru.' });
        }

        const protestCheck = await db.query(
            'SELECT id FROM grade_protests WHERE submission_id = $1 AND student_id = $2',
            [submissionId, studentId]
        );

        if (protestCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Anda sudah mengajukan sanggahan untuk tugas ini sebelumnya.' });
        }

        const query = `
            INSERT INTO grade_protests (submission_id, student_id, reason, requested_grade, status)
            VALUES ($1, $2, $3, $4, 'Pending')
            RETURNING *
        `;
        const result = await db.query(query, [submissionId, studentId, reason, parseInt(requestedGrade, 10)]);

        return res.status(201).json({
            message: 'Sanggahan nilai berhasil dikirimkan ke guru pengampu.',
            protest: result.rows[0]
        });
    } catch (err) {
        console.error('Create Protest Error:', err);
        return res.status(500).json({ error: `Gagal mengirimkan sanggahan: ${err.message}` });
    }
});

// 2. Get Student's Grade Protests (GET /api/protests/student)
router.get('/student', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const studentId = req.user.id;

    try {
        const query = `
            SELECT gp.id, gp.reason, gp.requested_grade, gp.status, gp.teacher_feedback, gp.created_at,
                   a.title AS assignment_title, sub.grade AS original_grade
            FROM grade_protests gp
            JOIN assessment_submissions sub ON gp.submission_id = sub.id
            JOIN assessments a ON sub.assessment_id = a.id
            WHERE gp.student_id = $1
            ORDER BY gp.id DESC
        `;
        const result = await db.query(query, [studentId]);
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Student Protests Error:', err);
        return res.status(500).json({ error: `Gagal mengambil riwayat sanggahan: ${err.message}` });
    }
});

// 3. Get Teacher's Received Grade Protests (GET /api/protests/teacher)
router.get('/teacher', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    try {
        const query = `
            SELECT gp.id, gp.reason, gp.requested_grade, gp.status, gp.teacher_feedback, gp.created_at,
                   u.name AS student_name, c.name AS grade_level, a.title AS assignment_title, sub.grade AS original_grade,
                   gp.submission_id
            FROM grade_protests gp
            JOIN users u ON gp.student_id = u.id
            JOIN assessment_submissions sub ON gp.submission_id = sub.id
            JOIN assessments a ON sub.assessment_id = a.id
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN classes c ON cs.class_id = c.id
            WHERE cs.teacher_id = $1 AND u.school_id = $2
            ORDER BY gp.status = 'Pending' DESC, gp.id DESC
        `;
        const result = await db.query(query, [teacherId, schoolId]);
        return res.json(result.rows);
    } catch (err) {
        console.error('Get Teacher Protests Error:', err);
        return res.status(500).json({ error: `Gagal mengambil daftar sanggahan masuk: ${err.message}` });
    }
});

// 4. Review Grade Protest (PUT /api/protests/:id/review)
router.put('/:id/review', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const { id } = req.params;
    const { status, teacher_feedback, finalGrade } = req.body;
    const teacherId = req.user.id;
    const school_id = req.user.school_id;

    if (!status || !['Disetujui', 'Ditolak'].includes(status)) {
        return res.status(400).json({ error: 'Status keputusan (Disetujui atau Ditolak) wajib diisi.' });
    }

    try {
        const protestQuery = `
            SELECT gp.id, gp.student_id, gp.submission_id, sub.assessment_id, gp.requested_grade, sub.grade AS original_grade
            FROM grade_protests gp
            JOIN assessment_submissions sub ON gp.submission_id = sub.id
            JOIN assessments a ON sub.assessment_id = a.id
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN classes c ON cs.class_id = c.id
            WHERE gp.id = $1 AND cs.teacher_id = $2 AND c.school_id = $3
        `;
        const protestRes = await db.query(protestQuery, [id, teacherId, school_id]);
        if (protestRes.rows.length === 0) {
            return res.status(404).json({ error: 'Pengajuan sanggahan tidak ditemukan atau Anda tidak berwenang.' });
        }

        const protest = protestRes.rows[0];

        await db.query(
            `UPDATE grade_protests 
             SET status = $1, teacher_feedback = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [status, teacher_feedback || null, id]
        );

        if (status === 'Disetujui') {
            const resolvedGrade = finalGrade !== undefined ? parseInt(finalGrade, 10) : protest.requested_grade;
            
            await db.query(
                `UPDATE assessment_submissions 
                 SET grade = $1, status = 'Sudah Dinilai'
                 WHERE id = $2`,
                [resolvedGrade, protest.submission_id]
            );

            const gradeDifference = resolvedGrade - (protest.original_grade || 0);
            if (gradeDifference !== 0) {
                await rewardXp(protest.student_id, gradeDifference, 'tugas_revisi', protest.assessment_id);
            }
        }

        // Fetch assessment title for notification
        const asmQuery = `
            SELECT a.title 
            FROM assessments a 
            WHERE a.id = $1
        `;
        const asmRes = await db.query(asmQuery, [protest.assessment_id]);
        const asmTitle = asmRes.rows.length > 0 ? asmRes.rows[0].title : 'Tugas';

        // Insert notification for student
        await db.query(`
            INSERT INTO notifications (school_id, user_id, title, message, type, link_path)
            VALUES ($1, $2, $3, $4, 'sanggahan_selesai', $5)
        `, [
            school_id,
            protest.student_id,
            'Keputusan Sanggahan Nilai',
            `Sanggahan nilai untuk tugas "${asmTitle}" Anda telah ditinjau dan dinyatakan ${status.toLowerCase()}.`,
            'sanggahan_selesai',
            '/scores'
        ]);

        return res.json({ message: `Sanggahan nilai berhasil diulas dengan keputusan: ${status}.` });
    } catch (err) {
        console.error('Review Protest Error:', err);
        return res.status(500).json({ error: `Gagal mengulas sanggahan: ${err.message}` });
    }
});

module.exports = router;
