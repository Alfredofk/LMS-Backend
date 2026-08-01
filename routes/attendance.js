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

// 0. Get Consolidated Student Attendance Summary & History (GET /api/attendance/student/summary)
router.get('/student/summary', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const studentId = req.user.id;

    try {
        // A. Fetch student's gamification streak info (daily_streak)
        const streakRes = await db.query(
            `SELECT daily_streak AS "dailyStreak" 
             FROM student_gamification 
             WHERE student_id = $1 LIMIT 1`,
            [studentId]
        );
        const dailyStreak = streakRes.rows.length > 0 ? streakRes.rows[0].dailyStreak : 0;

        // B. Fetch student's overall attendance history
        const historyRes = await db.query(
            `SELECT a.id, a.date::text AS "date", a.status, a.notes, a.created_at AS "createdAt",
                    s.name AS "subjectName", s.code AS "subjectCode"
             FROM attendances a
             JOIN class_subjects cs ON a.class_subject_id = cs.id
             JOIN subjects s ON cs.subject_id = s.id
             WHERE a.student_id = $1
             ORDER BY a.date DESC, a.created_at DESC`,
            [studentId]
        );
        const history = historyRes.rows;

        // C. Calculate counts
        let hadir = 0;
        let izin = 0;
        let sakit = 0;
        let alpa = 0;

        history.forEach(row => {
            if (row.status === 'Hadir') hadir++;
            else if (row.status === 'Izin') izin++;
            else if (row.status === 'Sakit') sakit++;
            else if (row.status === 'Alpa') alpa++;
        });

        const total = history.length;
        const percentage = total > 0 ? Math.round((hadir / total) * 100) : 100;

        return res.json({
            summary: {
                total,
                hadir,
                izin,
                sakit,
                alpa,
                percentage,
                dailyStreak
            },
            history
        });
    } catch (err) {
        console.error('Get Consolidated Attendance Error:', err);
        return res.status(500).json({ error: `Gagal mengambil riwayat absensi: ${err.message}` });
    }
});

// 1. Get Student Attendance History & Summary (GET /api/attendance/student/:courseId)
router.get('/student/:courseId', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const { courseId } = req.params;
    const studentId = req.user.id;

    try {
        // Fetch all attendance records for this student and class_subject
        const historyRes = await db.query(
            `SELECT id, date::text, status, notes, created_at
             FROM attendances
             WHERE class_subject_id = $1 AND student_id = $2
             ORDER BY date DESC`,
            [courseId, studentId]
        );
        const history = historyRes.rows;

        // Calculate counts
        let hadir = 0;
        let izin = 0;
        let sakit = 0;
        let alpa = 0;

        history.forEach(row => {
            if (row.status === 'Hadir') hadir++;
            else if (row.status === 'Izin') izin++;
            else if (row.status === 'Sakit') sakit++;
            else if (row.status === 'Alpa') alpa++;
        });

        const total = history.length;
        const percentage = total > 0 ? Math.round((hadir / total) * 100) : 100;

        // Check if student checked in for today
        const checkToday = await db.query(
            `SELECT id, status FROM attendances 
             WHERE class_subject_id = $1 AND student_id = $2 AND date = CURRENT_DATE`,
            [courseId, studentId]
        );
        const hasCheckedInToday = checkToday.rows.length > 0;
        const todayStatus = hasCheckedInToday ? checkToday.rows[0].status : null;

        return res.json({
            summary: {
                total,
                hadir,
                izin,
                sakit,
                alpa,
                percentage
            },
            history,
            hasCheckedInToday,
            todayStatus
        });
    } catch (err) {
        console.error('Get Student Attendance Error:', err);
        return res.status(500).json({ error: `Gagal memuat absensi murid: ${err.message}` });
    }
});

// 2. Student Self Check-In Today (POST /api/attendance/student/:courseId/checkin)
router.post('/student/:courseId/checkin', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const { courseId } = req.params;
    const studentId = req.user.id;

    try {
        // Check duplicate
        const checkToday = await db.query(
            `SELECT id FROM attendances 
             WHERE class_subject_id = $1 AND student_id = $2 AND date = CURRENT_DATE`,
            [courseId, studentId]
        );
        if (checkToday.rows.length > 0) {
            return res.status(400).json({ error: 'Anda sudah mengisi absensi hari ini.' });
        }

        // Insert attendance
        const insertQuery = `
            INSERT INTO attendances (class_subject_id, student_id, date, status, notes)
            VALUES ($1, $2, CURRENT_DATE, 'Hadir', 'Presensi mandiri siswa')
            RETURNING *
        `;
        const result = await db.query(insertQuery, [courseId, studentId]);

        // Update daily streak in gamification
        let streakRes = await db.query(
            'SELECT daily_streak, last_active_date FROM student_gamification WHERE student_id = $1',
            [studentId]
        );
        let newStreak = 1;
        if (streakRes.rows.length > 0) {
            const lastActive = streakRes.rows[0].last_active_date;
            const streak = streakRes.rows[0].daily_streak || 0;
            if (lastActive) {
                const today = new Date();
                const lastDate = new Date(lastActive);
                const timeDiff = Math.abs(today.setHours(0,0,0,0) - lastDate.setHours(0,0,0,0));
                const diffDays = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
                
                if (diffDays === 1) {
                    newStreak = streak + 1;
                } else if (diffDays === 0) {
                    newStreak = streak;
                } else {
                    newStreak = 1;
                }
            }
            await db.query(
                'UPDATE student_gamification SET daily_streak = $1, last_active_date = CURRENT_DATE WHERE student_id = $2',
                [newStreak, studentId]
            );
        } else {
            await db.query(
                "INSERT INTO student_gamification (student_id, xp, level, daily_streak, last_active_date) VALUES ($1, 0, 1, 1, CURRENT_DATE)",
                [studentId]
            );
        }

        // Reward +10 XP for checking in (gamification incentive)
        await rewardXp(studentId, 10, 'absensi', result.rows[0].id);

        return res.status(201).json({
            message: `Presensi hadir hari ini berhasil dicatat! (+10 XP, Streak: ${newStreak} Hari)`,
            attendance: result.rows[0]
        });
    } catch (err) {
        console.error('Student Check-in Error:', err);
        return res.status(500).json({ error: `Gagal check-in presensi: ${err.message}` });
    }
});

// 3. Student Submit Excuse / Absence Notice (POST /api/attendance/student/:courseId/excuse)
router.post('/student/:courseId/excuse', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const { courseId } = req.params;
    const studentId = req.user.id;
    const { status, notes } = req.body; // status: 'Izin' or 'Sakit'

    if (!status || !['Izin', 'Sakit'].includes(status)) {
        return res.status(400).json({ error: 'Status ketidakhadiran (Izin/Sakit) wajib diisi.' });
    }
    if (!notes || notes.trim().length === 0) {
        return res.status(400).json({ error: 'Alasan atau keterangan izin wajib diisi.' });
    }

    try {
        // Check duplicate
        const checkToday = await db.query(
            `SELECT id FROM attendances 
             WHERE class_subject_id = $1 AND student_id = $2 AND date = CURRENT_DATE`,
            [courseId, studentId]
        );
        if (checkToday.rows.length > 0) {
            return res.status(400).json({ error: 'Anda sudah mengisi absensi hari ini.' });
        }

        const insertQuery = `
            INSERT INTO attendances (class_subject_id, student_id, date, status, notes)
            VALUES ($1, $2, CURRENT_DATE, $3, $4)
            RETURNING *
        `;
        const result = await db.query(insertQuery, [courseId, studentId, status, notes]);

        return res.status(201).json({
            message: `Keterangan ${status} hari ini berhasil dikirimkan ke guru pengampu.`,
            attendance: result.rows[0]
        });
    } catch (err) {
        console.error('Student Excuse Submission Error:', err);
        return res.status(500).json({ error: `Gagal mengirim keterangan izin: ${err.message}` });
    }
});

// 4. Get Teacher Class Attendance Rekap (GET /api/attendance/teacher/:courseId)
router.get('/teacher/:courseId', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const { courseId } = req.params;
    const schoolId = req.user.school_id;
    const targetDate = req.query.date || new Date().toISOString().split('T')[0];

    try {
        // Verify class subject ownership
        const courseCheck = await db.query(
            `SELECT cs.id 
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.id = $1 AND c.school_id = $2 AND cs.teacher_id = $3`, 
            [courseId, schoolId, req.user.id]
        );
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan atau Anda tidak berwenang.' });
        }

        // Fetch students enrolled in this course
        const studentsQuery = `
            SELECT u.id, u.name, u.nis
            FROM users u
            JOIN class_enrollments ce ON u.id = ce.student_id
            JOIN class_subjects cs ON ce.class_id = cs.class_id
            WHERE cs.id = $1 AND u.school_id = $2
            ORDER BY u.name ASC
        `;
        const studentsRes = await db.query(studentsQuery, [courseId, schoolId]);
        const students = studentsRes.rows;

        // Fetch attendance records for the class on this target date
        const attendanceRes = await db.query(
            `SELECT student_id, status, notes
             FROM attendances
             WHERE class_subject_id = $1 AND date = $2`,
            [courseId, targetDate]
        );
        const attendanceList = attendanceRes.rows;

        // Map existing attendance records
        const attendanceMap = {};
        attendanceList.forEach(att => {
            attendanceMap[att.student_id] = {
                status: att.status,
                notes: att.notes
            };
        });

        // Consolidate students list with their attendance status
        const list = students.map(student => {
            const att = attendanceMap[student.id] || { status: 'Alpa', notes: '' };
            return {
                id: student.id,
                name: student.name,
                nis: student.nis,
                status: att.status,
                notes: att.notes || ''
            };
        });

        return res.json({
            date: targetDate,
            attendances: list
        });
    } catch (err) {
        console.error('Get Teacher Rekap Attendance Error:', err);
        return res.status(500).json({ error: `Gagal mengambil rekap absensi kelas: ${err.message}` });
    }
});

// 5. Teacher Save/Update Class Attendance (POST /api/attendance/teacher/:courseId/save)
router.post('/teacher/:courseId/save', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const { courseId } = req.params;
    const { date, attendances } = req.body;
    const schoolId = req.user.school_id;

    if (!date || !Array.isArray(attendances)) {
        return res.status(400).json({ error: 'Tanggal dan rekap daftar absensi wajib diisi.' });
    }

    try {
        // Verify class subject ownership
        const courseCheck = await db.query(
            `SELECT cs.id 
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.id = $1 AND c.school_id = $2 AND cs.teacher_id = $3`, 
            [courseId, schoolId, req.user.id]
        );
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan atau Anda tidak berwenang.' });
        }

        // Upsert attendance records
        for (const item of attendances) {
            const { studentId, status, notes } = item;
            
            const query = `
                INSERT INTO attendances (class_subject_id, student_id, date, status, notes)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (class_subject_id, student_id, date) 
                DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes
            `;
            await db.query(query, [courseId, studentId, date, status, notes || null]);
        }

        return res.json({ message: 'Rekapitulasi absensi kelas berhasil disimpan secara permanen.' });
    } catch (err) {
        console.error('Save Attendance Error:', err);
        return res.status(500).json({ error: `Gagal menyimpan rekapitulasi absensi: ${err.message}` });
    }
});

module.exports = router;
