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

// 1. Get Student Schedule & Deadlines (GET /api/schedule/student)
router.get('/student', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const studentId = req.user.id;
    const schoolId = req.user.school_id;

    try {
        // A. Fetch student's weekly recurring class schedules
        const scheduleQuery = `
            SELECT sch.id, sch.day_of_week AS "dayOfWeek", sch.start_time AS "startTime", sch.end_time AS "endTime", sch.room,
                   s.name AS "subjectName", s.code AS "subjectCode", u.name AS "teacherName"
            FROM class_schedules sch
            JOIN class_subjects cs ON sch.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN users u ON cs.teacher_id = u.id
            WHERE sch.school_id = $1 AND cs.class_id = (
                SELECT class_id FROM class_enrollments WHERE student_id = $2 LIMIT 1
            )
            ORDER BY sch.day_of_week ASC, sch.start_time ASC
        `;
        const schedulesResult = await db.query(scheduleQuery, [schoolId, studentId]);

        // B. Fetch student's active assignments/deadlines
        const deadlinesQuery = `
            SELECT a.id, a.title, a.deadline, s.name AS "subjectName"
            FROM assessments a
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN class_enrollments ce ON cs.class_id = ce.class_id
            WHERE sch_id_dummy_check_not_needed = 1 OR ce.student_id = $1 AND a.type = 'tugas'
            ORDER BY a.deadline ASC
        `;
        // Wait, the dummy check is just to bypass but ce.student_id = $1 is correct:
        const deadlinesQueryFixed = `
            SELECT a.id, a.title, a.deadline, s.name AS "subjectName"
            FROM assessments a
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN class_enrollments ce ON cs.class_id = ce.class_id
            WHERE ce.student_id = $1 AND a.type = 'tugas'
            ORDER BY a.deadline ASC
        `;
        const deadlinesResult = await db.query(deadlinesQueryFixed, [studentId]);

        return res.json({
            weeklySchedules: schedulesResult.rows,
            deadlines: deadlinesResult.rows
        });
    } catch (err) {
        console.error('Get Student Schedule Error:', err);
        return res.status(500).json({ error: `Gagal mengambil jadwal siswa: ${err.message}` });
    }
});

// 2. Get Teacher Schedule & Deadlines (GET /api/schedule/teacher)
router.get('/teacher', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    try {
        // A. Fetch teacher's teaching schedules
        const scheduleQuery = `
            SELECT sch.id, sch.day_of_week AS "dayOfWeek", sch.start_time AS "startTime", sch.end_time AS "endTime", sch.room,
                   s.name AS "subjectName", s.code AS "subjectCode", c.name AS "className"
            FROM class_schedules sch
            JOIN class_subjects cs ON sch.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN classes c ON cs.class_id = c.id
            WHERE sch.school_id = $1 AND cs.teacher_id = $2
            ORDER BY sch.day_of_week ASC, sch.start_time ASC
        `;
        const schedulesResult = await db.query(scheduleQuery, [schoolId, teacherId]);

        // B. Fetch assignments/deadlines posted by this teacher
        const deadlinesQuery = `
            SELECT a.id, a.title, a.deadline, s.name AS "subjectName", c.name AS "className"
            FROM assessments a
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN classes c ON cs.class_id = c.id
            WHERE cs.teacher_id = $1 AND a.type = 'tugas'
            ORDER BY a.deadline ASC
        `;
        const deadlinesResult = await db.query(deadlinesQuery, [teacherId]);

        return res.json({
            weeklySchedules: schedulesResult.rows,
            deadlines: deadlinesResult.rows
        });
    } catch (err) {
        console.error('Get Teacher Schedule Error:', err);
        return res.status(500).json({ error: `Gagal mengambil jadwal guru: ${err.message}` });
    }
});

// 3. Get Headmaster/All Schedules Overview (GET /api/schedule/headmaster)
router.get('/headmaster', verifyToken, ensureSchoolAssociated, async (req, res) => {
    const schoolId = req.user.school_id;

    try {
        // Fetch all schedules in the school
        const scheduleQuery = `
            SELECT sch.id, sch.day_of_week AS "dayOfWeek", sch.start_time AS "startTime", sch.end_time AS "endTime", sch.room,
                   s.name AS "subjectName", s.code AS "subjectCode", c.name AS "className", u.name AS "teacherName"
            FROM class_schedules sch
            JOIN class_subjects cs ON sch.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN classes c ON cs.class_id = c.id
            JOIN users u ON cs.teacher_id = u.id
            WHERE sch.school_id = $1
            ORDER BY c.name ASC, sch.day_of_week ASC, sch.start_time ASC
        `;
        const schedulesResult = await db.query(scheduleQuery, [schoolId]);

        // Fetch all assignments in the school
        const deadlinesQuery = `
            SELECT a.id, a.title, a.deadline, s.name AS "subjectName", c.name AS "className"
            FROM assessments a
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN classes c ON cs.class_id = c.id
            WHERE c.school_id = $1 AND a.type = 'tugas'
            ORDER BY a.deadline ASC
        `;
        const deadlinesResult = await db.query(deadlinesQuery, [schoolId]);

        return res.json({
            weeklySchedules: schedulesResult.rows,
            deadlines: deadlinesResult.rows
        });
    } catch (err) {
        console.error('Get Headmaster Schedule Error:', err);
        return res.status(500).json({ error: `Gagal mengambil jadwal sekolah: ${err.message}` });
    }
});

module.exports = router;
