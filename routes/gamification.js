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

// 1. Get Student Stats (GET /api/student/stats)
router.get('/student/stats', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const studentId = req.user.id;

    try {
        const coursesCountRes = await db.query(
            `SELECT COUNT(DISTINCT cs.id) 
             FROM class_enrollments ce
             JOIN class_subjects cs ON ce.class_id = cs.class_id
             WHERE ce.student_id = $1`,
            [studentId]
        );
        const totalCourses = parseInt(coursesCountRes.rows[0].count, 10) || 0;

        const pendingTasksRes = await db.query(
            `SELECT COUNT(*) 
             FROM assessments a
             JOIN sessions s ON a.session_id = s.id
             JOIN class_subjects cs ON s.class_subject_id = cs.id
             JOIN class_enrollments ce ON cs.class_id = ce.class_id
             LEFT JOIN assessment_submissions sub ON a.id = sub.assessment_id AND sub.student_id = $1
             WHERE ce.student_id = $1 AND a.type = 'tugas' AND (sub.id IS NULL OR sub.grade IS NULL)`,
            [studentId]
        );
        const totalTodo = parseInt(pendingTasksRes.rows[0].count, 10) || 0;

        const avgGradeRes = await db.query(
            `SELECT AVG(grade) FROM assessment_submissions WHERE student_id = $1 AND grade IS NOT NULL`,
            [studentId]
        );
        const rawAvg = parseFloat(avgGradeRes.rows[0].avg);
        const avgScore = isNaN(rawAvg) ? '—' : rawAvg.toFixed(1);

        const materialsCountRes = await db.query(
            `SELECT COUNT(m.id)
             FROM materials m
             JOIN sessions s ON m.session_id = s.id
             JOIN class_subjects cs ON s.class_subject_id = cs.id
             JOIN class_enrollments ce ON cs.class_id = ce.class_id
             WHERE ce.student_id = $1`,
            [studentId]
        );
        const totalMaterials = parseInt(materialsCountRes.rows[0].count, 10) || 0;

        return res.json({
            totalCourses,
            totalTodo,
            avgScore,
            totalMaterials
        });
    } catch (err) {
        console.error('Get Student Stats Error:', err);
        return res.status(500).json({ error: `Gagal mengambil statistik siswa: ${err.message}` });
    }
});

// 2. Get Teacher Stats (GET /api/teacher/stats)
router.get('/teacher/stats', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    try {
        const classesCountRes = await db.query(
            `SELECT COUNT(*) FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.teacher_id = $1 AND c.school_id = $2`,
            [teacherId, schoolId]
        );
        const totalClasses = parseInt(classesCountRes.rows[0].count, 10) || 0;

        const studentsCountRes = await db.query(
            `SELECT COUNT(DISTINCT ce.student_id) 
             FROM class_enrollments ce 
             JOIN class_subjects cs ON ce.class_id = cs.class_id 
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.teacher_id = $1 AND c.school_id = $2`,
            [teacherId, schoolId]
        );
        const totalStudents = parseInt(studentsCountRes.rows[0].count, 10) || 0;

        const pendingGradingRes = await db.query(
            `SELECT COUNT(*) 
             FROM assessment_submissions s 
             JOIN assessments a ON s.assessment_id = a.id 
             JOIN sessions sec ON a.session_id = sec.id 
             JOIN class_subjects cs ON sec.class_subject_id = cs.id 
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.teacher_id = $1 AND c.school_id = $2 AND s.status = 'Belum Dinilai'`,
            [teacherId, schoolId]
        );
        const pendingGrading = parseInt(pendingGradingRes.rows[0].count, 10) || 0;

        return res.json({
            totalClasses,
            totalStudents,
            pendingGrading
        });
    } catch (err) {
        console.error('Get Teacher Stats Error:', err);
        return res.status(500).json({ error: `Gagal memuat statistik guru: ${err.message}` });
    }
});

// 3. Get Teacher's Recent Submissions (GET /api/teacher/recent-submissions)
router.get('/teacher/recent-submissions', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    try {
        const query = `
            SELECT s.id, u.name AS student_name, c.name AS grade_level, a.title AS assignment_title, s.submitted_at
            FROM assessment_submissions s
            JOIN users u ON s.student_id = u.id
            JOIN assessments a ON s.assessment_id = a.id
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN classes c ON cs.class_id = c.id
            WHERE cs.teacher_id = $1 AND u.school_id = $2
            ORDER BY s.submitted_at DESC
            LIMIT 5
        `;
        const result = await db.query(query, [teacherId, schoolId]);
        
        const formatted = result.rows.map(row => {
            const diff = Date.now() - new Date(row.submitted_at).getTime();
            const diffMinutes = Math.floor(diff / 60000);
            let timeStr = 'Baru saja';
            if (diffMinutes > 0 && diffMinutes < 60) {
                timeStr = `${diffMinutes} menit yang lalu`;
            } else if (diffMinutes >= 60 && diffMinutes < 1440) {
                timeStr = `${Math.floor(diffMinutes / 60)} jam yang lalu`;
            } else if (diffMinutes >= 1440) {
                timeStr = `${Math.floor(diffMinutes / 1440)} hari yang lalu`;
            }
            return {
                id: row.id,
                studentName: row.student_name,
                grade: row.grade_level,
                assignmentTitle: row.assignment_title,
                time: timeStr
            };
        });

        return res.json(formatted);
    } catch (err) {
        console.error('Get Recent Submissions Error:', err);
        return res.status(500).json({ error: `Gagal mengambil riwayat pengumpulan: ${err.message}` });
    }
});

// 4. Get Active Student Gamification Profile (GET /api/gamification/profile)
router.get('/gamification/profile', verifyToken, authorizeRoles('student'), async (req, res) => {
    const studentId = req.user.id;

    try {
        let statsRes = await db.query(
            'SELECT xp, level, daily_streak, task_streak FROM student_gamification WHERE student_id = $1',
            [studentId]
        );

        if (statsRes.rows.length === 0) {
            await db.query(
                'INSERT INTO student_gamification (student_id, xp, level) VALUES ($1, 0, 1)',
                [studentId]
            );
            statsRes = { rows: [{ xp: 0, level: 1, daily_streak: 0, task_streak: 0 }] };
        }

        const stats = statsRes.rows[0];

        const badgesRes = await db.query(
            `SELECT bd.name, bd.description, bd.icon, sb.unlocked_at
             FROM student_badges sb
             JOIN badge_definitions bd ON sb.badge_id = bd.id
             WHERE sb.student_id = $1
             ORDER BY sb.unlocked_at DESC`,
            [studentId]
        );

        const transactionsRes = await db.query(
            `SELECT amount, source_type, created_at
             FROM xp_transactions
             WHERE student_id = $1
             ORDER BY id DESC
             LIMIT 10`,
            [studentId]
        );

        const currentLevelXp = stats.xp % 1000;
        const nextLevelXp = 1000;
        const progressPercentage = Math.round((currentLevelXp / nextLevelXp) * 100);

        return res.json({
            xp: stats.xp,
            level: stats.level,
            dailyStreak: stats.daily_streak,
            taskStreak: stats.task_streak,
            nextLevelPercentage: progressPercentage,
            xpRemaining: nextLevelXp - currentLevelXp,
            badges: badgesRes.rows,
            history: transactionsRes.rows
        });
    } catch (err) {
        console.error('Get Gamification Profile Error:', err);
        return res.status(500).json({ error: `Gagal mengambil profil gamifikasi: ${err.message}` });
    }
});

// 5. Get Leaderboard (GET /api/leaderboard)
router.get('/leaderboard', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const schoolId = req.user.school_id;
    const { classSubjectId } = req.query;

    try {
        let query;
        let params;

        if (classSubjectId) {
            query = `
                SELECT u.id, u.name, u.nis, COALESCE(sg.xp, 0) as xp, COALESCE(sg.level, 1) as level
                FROM users u
                JOIN class_enrollments ce ON u.id = ce.student_id
                JOIN class_subjects cs ON ce.class_id = cs.class_id
                LEFT JOIN student_gamification sg ON u.id = sg.student_id
                WHERE cs.id = $1 AND u.school_id = $2
                ORDER BY xp DESC, u.name ASC
            `;
            params = [classSubjectId, schoolId];
        } else {
            query = `
                SELECT u.id, u.name, u.nis, COALESCE(sg.xp, 0) as xp, COALESCE(sg.level, 1) as level
                FROM users u
                LEFT JOIN student_gamification sg ON u.id = sg.student_id
                WHERE u.school_id = $1 AND u.role = 'student'
                ORDER BY xp DESC, u.name ASC
                LIMIT 50
            `;
            params = [schoolId];
        }

        const result = await db.query(query, params);
        
        const rankedList = result.rows.map((row, idx) => ({
            rank: idx + 1,
            ...row
        }));

        return res.json(rankedList);
    } catch (err) {
        console.error('Get Leaderboard Error:', err);
        return res.status(500).json({ error: `Gagal memuat papan peringkat: ${err.message}` });
    }
});

module.exports = router;
