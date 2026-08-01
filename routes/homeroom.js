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

// 1. Get Homeroom Class Overview (GET /api/homeroom/class)
router.get('/class', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    try {
        // Fetch class where this teacher is homeroom teacher
        const classRes = await db.query(
            `SELECT id, name FROM classes 
             WHERE school_id = $1 AND homeroom_teacher_id = $2`,
            [schoolId, teacherId]
        );

        if (classRes.rows.length === 0) {
            return res.json({ isHomeroomTeacher: false, classInfo: null });
        }

        const classInfo = classRes.rows[0];

        // Count total students enrolled in this class
        const studentsCount = await db.query(
            `SELECT COUNT(*) FROM class_enrollments WHERE class_id = $1`,
            [classInfo.id]
        );
        const totalStudents = parseInt(studentsCount.rows[0].count, 10) || 0;

        return res.json({
            isHomeroomTeacher: true,
            classInfo: {
                id: classInfo.id,
                name: classInfo.name,
                totalStudents
            }
        });
    } catch (err) {
        console.error('Get Homeroom Class Info Error:', err);
        return res.status(500).json({ error: `Gagal memuat info kelas perwalian: ${err.message}` });
    }
});

// 2. Get Homeroom Students Rekap & Anomalies (GET /api/homeroom/students)
router.get('/students', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    try {
        // Fetch homeroom class
        const classRes = await db.query(
            `SELECT id, name FROM classes 
             WHERE school_id = $1 AND homeroom_teacher_id = $2`,
            [schoolId, teacherId]
        );
        if (classRes.rows.length === 0) {
            return res.status(403).json({ error: 'Anda bukan Wali Kelas untuk kelas mana pun.' });
        }
        const classId = classRes.rows[0].id;

        // 1. Fetch all students in the class
        const studentsRes = await db.query(
            `SELECT u.id, u.name, u.nis, u.xp, u.level, u.email
             FROM users u
             JOIN class_enrollments ce ON u.id = ce.student_id
             WHERE ce.class_id = $1 AND u.role = 'student'
             ORDER BY u.name ASC`,
            [classId]
        );
        const students = studentsRes.rows;

        // 2. Fetch global average grade for each student in this class
        const gradesRes = await db.query(
            `SELECT sub.student_id, AVG(sub.grade) as avg_grade
             FROM assessment_submissions sub
             JOIN assessments a ON sub.assessment_id = a.id
             JOIN sessions s ON a.session_id = s.id
             JOIN class_subjects cs ON s.class_subject_id = cs.id
             WHERE cs.class_id = $1 AND sub.grade IS NOT NULL
             GROUP BY sub.student_id`,
            [classId]
        );
        const gradesMap = {};
        gradesRes.rows.forEach(g => {
            gradesMap[g.student_id] = parseFloat(g.avg_grade);
        });

        // 3. Fetch attendance counts for each student in this class
        const attendanceRes = await db.query(
            `SELECT student_id,
                    COUNT(*) as total,
                    COUNT(CASE WHEN status = 'Hadir' THEN 1 END) as hadir,
                    COUNT(CASE WHEN status = 'Izin' THEN 1 END) as izin,
                    COUNT(CASE WHEN status = 'Sakit' THEN 1 END) as sakit,
                    COUNT(CASE WHEN status = 'Alpa' THEN 1 END) as alpa
             FROM attendances
             WHERE class_subject_id IN (SELECT id FROM class_subjects WHERE class_id = $1)
             GROUP BY student_id`,
            [classId]
        );
        const attendanceMap = {};
        attendanceRes.rows.forEach(a => {
            const total = parseInt(a.total, 10);
            const hadir = parseInt(a.hadir, 10);
            attendanceMap[a.student_id] = {
                attendanceRate: total > 0 ? Math.round((hadir / total) * 100) : 100,
                hadir,
                izin: parseInt(a.izin, 10),
                sakit: parseInt(a.sakit, 10),
                alpa: parseInt(a.alpa, 10)
            };
        });

        // 4. Combine into final list with anomaly alert tagging
        const list = students.map(student => {
            const avgGrade = gradesMap[student.id] !== undefined ? Math.round(gradesMap[student.id]) : null;
            const att = attendanceMap[student.id] || { attendanceRate: 100, hadir: 0, izin: 0, sakit: 0, alpa: 0 };

            let warning = false;
            let alertMessage = 'Normal';

            if (att.attendanceRate < 75) {
                warning = true;
                alertMessage = 'Kehadiran Rendah (<75%)';
            } else if (avgGrade !== null && avgGrade < 70) {
                warning = true;
                alertMessage = 'Akademik Rendah (<70)';
            } else if (att.alpa > 2) {
                warning = true;
                alertMessage = 'Banyak Mangkir';
            }

            return {
                id: student.id,
                name: student.name,
                nis: student.nis,
                email: student.email,
                xp: student.xp,
                level: student.level,
                averageGrade: avgGrade,
                attendanceRate: att.attendanceRate,
                attendanceStats: {
                    hadir: att.hadir,
                    izin: att.izin,
                    sakit: att.sakit,
                    alpa: att.alpa
                },
                warning,
                alertMessage
            };
        });

        return res.json(list);
    } catch (err) {
        console.error('Get Homeroom Students Error:', err);
        return res.status(500).json({ error: `Gagal memuat rekap siswa perwalian: ${err.message}` });
    }
});

// 3. Get Student Detailed Report for Homeroom (GET /api/homeroom/student/:studentId/report)
router.get('/student/:studentId/report', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const { studentId } = req.params;
    const teacherId = req.user.id;
    const schoolId = req.user.school_id;

    try {
        // Verify this student belongs to class where teacher is homeroom teacher
        const classRes = await db.query(
            `SELECT id FROM classes 
             WHERE school_id = $1 AND homeroom_teacher_id = $2`,
            [schoolId, teacherId]
        );
        if (classRes.rows.length === 0) {
            return res.status(403).json({ error: 'Anda bukan Wali Kelas untuk kelas mana pun.' });
        }
        const classId = classRes.rows[0].id;

        const enrollmentCheck = await db.query(
            `SELECT student_id FROM class_enrollments WHERE class_id = $1 AND student_id = $2`,
            [classId, studentId]
        );
        if (enrollmentCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Siswa tidak ditemukan dalam kelas perwalian Anda.' });
        }

        // 1. Fetch Student Core Details
        const studentInfoRes = await db.query(
            `SELECT id, name, nis, email, xp, level FROM users WHERE id = $1`,
            [studentId]
        );
        const studentInfo = studentInfoRes.rows[0];

        // 2. Fetch Average Grade & Attendance per Subject for this student
        const subjectsRes = await db.query(
            `SELECT cs.id AS class_subject_id, s.name AS subject_name, s.code AS subject_code
             FROM class_subjects cs
             JOIN subjects s ON cs.subject_id = s.id
             WHERE cs.class_id = $1`,
            [classId]
        );
        const subjects = subjectsRes.rows;

        // Fetch grades for student per class_subject
        const gradesRes = await db.query(
            `SELECT cs.id AS class_subject_id, AVG(sub.grade) AS avg_grade
             FROM assessment_submissions sub
             JOIN assessments a ON sub.assessment_id = a.id
             JOIN sessions sec ON a.session_id = sec.id
             JOIN class_subjects cs ON sec.class_subject_id = cs.id
             WHERE sub.student_id = $1 AND sub.grade IS NOT NULL
             GROUP BY cs.id`,
            [studentId]
        );
        const gradesMap = {};
        gradesRes.rows.forEach(g => {
            gradesMap[g.class_subject_id] = parseFloat(g.avg_grade);
        });

        // Fetch attendance rates per class_subject
        const attendanceRes = await db.query(
            `SELECT class_subject_id,
                    COUNT(*) as total,
                    COUNT(CASE WHEN status = 'Hadir' THEN 1 END) as hadir
             FROM attendances
             WHERE student_id = $1
             GROUP BY class_subject_id`,
            [studentId]
        );
        const attendanceMap = {};
        attendanceRes.rows.forEach(a => {
            const total = parseInt(a.total, 10);
            const hadir = parseInt(a.hadir, 10);
            attendanceMap[a.class_subject_id] = total > 0 ? Math.round((hadir / total) * 100) : 100;
        });

        const subjectReports = subjects.map(sub => ({
            id: sub.class_subject_id,
            name: sub.subject_name,
            code: sub.subject_code,
            averageGrade: gradesMap[sub.class_subject_id] !== undefined ? Math.round(gradesMap[sub.class_subject_id]) : '—',
            attendanceRate: attendanceMap[sub.class_subject_id] !== undefined ? attendanceMap[sub.class_subject_id] : 100
        }));

        // 3. Fetch Badges unlocked
        const badgesRes = await db.query(
            `SELECT bd.name, bd.description, bd.icon, sb.unlocked_at
             FROM student_badges sb
             JOIN badge_definitions bd ON sb.badge_id = bd.id
             WHERE sb.student_id = $1
             ORDER BY sb.unlocked_at DESC`,
            [studentId]
        );

        return res.json({
            student: studentInfo,
            subjects: subjectReports,
            badges: badgesRes.rows
        });
    } catch (err) {
        console.error('Get Student Detailed Report Error:', err);
        return res.status(500).json({ error: `Gagal memuat detail laporan belajar siswa: ${err.message}` });
    }
});

module.exports = router;
