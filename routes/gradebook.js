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

// 1. Get Course Gradebook Data (GET /api/gradebook/:courseId)
router.get('/:courseId', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const { courseId } = req.params;
    const school_id = req.user.school_id;

    try {
        const courseCheck = await db.query(
            `SELECT cs.id 
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.id = $1 AND c.school_id = $2 AND cs.teacher_id = $3`, 
            [courseId, school_id, req.user.id]
        );
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan atau Anda tidak berwenang.' });
        }

        const assignmentsRes = await db.query(
            `SELECT a.id, a.title, COALESCE(a.weight, 0) as weight
             FROM assessments a
             JOIN sessions s ON a.session_id = s.id
             WHERE s.class_subject_id = $1 AND a.type = 'tugas'
             ORDER BY a.id ASC`,
            [courseId]
        );
        const assignments = assignmentsRes.rows;

        const studentsRes = await db.query(
            `SELECT u.id, u.name, u.nis, u.email
             FROM users u
             JOIN class_enrollments ce ON u.id = ce.student_id
             JOIN class_subjects cs ON ce.class_id = cs.class_id
             WHERE cs.id = $1 AND u.school_id = $2
             ORDER BY u.name ASC`,
            [courseId, school_id]
        );
        const students = studentsRes.rows;

        const submissionsRes = await db.query(
            `SELECT s.student_id, s.assessment_id, s.grade
             FROM assessment_submissions s
             JOIN assessments a ON s.assessment_id = a.id
             JOIN sessions sec ON a.session_id = sec.id
             WHERE sec.class_subject_id = $1 AND a.type = 'tugas'`,
            [courseId]
        );
        const submissions = submissionsRes.rows;

        const gradesMap = {};
        submissions.forEach(sub => {
            if (!gradesMap[sub.student_id]) {
                gradesMap[sub.student_id] = {};
            }
            gradesMap[sub.student_id][sub.assessment_id] = sub.grade;
        });

        const formattedStudents = students.map(student => {
            const studentGrades = {};
            assignments.forEach(asm => {
                studentGrades[asm.id] = (gradesMap[student.id] && gradesMap[student.id][asm.id] !== undefined)
                    ? gradesMap[student.id][asm.id]
                    : null;
            });

            return {
                id: student.id,
                name: student.name,
                nis: student.nis,
                email: student.email,
                grades: studentGrades
            };
        });

        return res.json({
            assignments,
            students: formattedStudents
        });
    } catch (err) {
        console.error('Get Gradebook Error:', err);
        return res.status(500).json({ error: `Gagal mengambil data buku nilai: ${err.message}` });
    }
});

// 2. Save Course Gradebook Updates (POST /api/gradebook/:courseId/save)
router.post('/:courseId/save', verifyToken, ensureSchoolAssociated, authorizeRoles('teacher'), async (req, res) => {
    const { courseId } = req.params;
    const { weights, grades } = req.body;
    const school_id = req.user.school_id;

    try {
        const courseCheck = await db.query(
            `SELECT cs.id 
             FROM class_subjects cs
             JOIN classes c ON cs.class_id = c.id
             WHERE cs.id = $1 AND c.school_id = $2 AND cs.teacher_id = $3`, 
            [courseId, school_id, req.user.id]
        );
        if (courseCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Mata pelajaran tidak ditemukan atau Anda tidak berwenang.' });
        }

        if (weights && typeof weights === 'object') {
            for (const [assignmentId, weight] of Object.entries(weights)) {
                await db.query(
                    'UPDATE assessments SET weight = $1 WHERE id = $2',
                    [parseInt(weight, 10) || 0, parseInt(assignmentId, 10)]
                );
            }
        }

        if (Array.isArray(grades)) {
            for (const gradeItem of grades) {
                const { studentId, assignmentId, grade } = gradeItem;
                const parsedGrade = (grade === '' || grade === null || grade === undefined) ? null : parseInt(grade, 10);

                const checkSub = await db.query(
                    'SELECT id FROM assessment_submissions WHERE student_id = $1 AND assessment_id = $2',
                    [studentId, assignmentId]
                );

                if (checkSub.rows.length > 0) {
                    await db.query(
                        `UPDATE assessment_submissions 
                         SET grade = $1, status = 'Sudah Dinilai' 
                         WHERE student_id = $2 AND assessment_id = $3`,
                        [parsedGrade, studentId, assignmentId]
                    );
                } else {
                    await db.query(
                        `INSERT INTO assessment_submissions (student_id, assessment_id, grade, file_url, file_name, status)
                         VALUES ($1, $2, $3, '', '', 'Sudah Dinilai')`,
                        [studentId, assignmentId, parsedGrade]
                    );
                }

                if (parsedGrade !== null && parsedGrade > 0) {
                    await rewardXp(studentId, parsedGrade, 'tugas', assignmentId);
                    
                    // Fetch assessment title
                    const asmRes = await db.query('SELECT title FROM assessments WHERE id = $1', [assignmentId]);
                    const asmTitle = asmRes.rows.length > 0 ? asmRes.rows[0].title : 'Tugas';

                    // Insert notification for student
                    await db.query(`
                        INSERT INTO notifications (school_id, user_id, title, message, type, link_path)
                        VALUES ($1, $2, $3, $4, 'nilai_masuk', $5)
                    `, [
                        school_id,
                        studentId,
                        'Nilai Tugas Diterbitkan',
                        `Nilai tugas "${asmTitle}" Anda telah diterbitkan. Nilai Anda: ${parsedGrade}.`,
                        'nilai_masuk',
                        '/scores'
                    ]);
                }
            }
        }

        return res.json({ message: 'Buku nilai berhasil disimpan secara permanen.' });
    } catch (err) {
        console.error('Save Gradebook Error:', err);
        return res.status(500).json({ error: `Gagal menyimpan perubahan buku nilai: ${err.message}` });
    }
});

// 3. Get Student Grade Summary (GET /api/gradebook/student/summary)
router.get('/student/summary', verifyToken, ensureSchoolAssociated, authorizeRoles('student'), async (req, res) => {
    const studentId = req.user.id;

    try {
        // Fetch enrolled courses
        const coursesRes = await db.query(
            `SELECT cs.id AS class_subject_id, s.name AS subject_name, s.code AS subject_code, u.name AS teacher_name
             FROM class_enrollments ce
             JOIN class_subjects cs ON ce.class_id = cs.class_id
             JOIN subjects s ON cs.subject_id = s.id
             LEFT JOIN users u ON cs.teacher_id = u.id
             WHERE ce.student_id = $1`,
            [studentId]
        );
        const courses = coursesRes.rows;

        // Fetch all assignments and student's submissions with grades and protest count
        const assignmentsRes = await db.query(
            `SELECT a.id AS assignment_id, a.title AS assignment_title, a.deadline, a.weight,
                    cs.id AS class_subject_id, sub.id AS submission_id, sub.grade, sub.status AS submission_status,
                    gp.id AS protest_id, gp.status AS protest_status
             FROM assessments a
             JOIN sessions s ON a.session_id = s.id
             JOIN class_subjects cs ON s.class_subject_id = cs.id
             JOIN class_enrollments ce ON cs.class_id = ce.class_id
             LEFT JOIN assessment_submissions sub ON a.id = sub.assessment_id AND sub.student_id = $1
             LEFT JOIN grade_protests gp ON sub.id = gp.submission_id
             WHERE ce.student_id = $1 AND a.type = 'tugas'
             ORDER BY a.id DESC`,
            [studentId]
        );
        const assignments = assignmentsRes.rows;

        // Group assignments by class_subject_id
        const courseMap = {};
        courses.forEach(c => {
            courseMap[c.class_subject_id] = {
                ...c,
                assignments: []
            };
        });

        assignments.forEach(a => {
            if (courseMap[a.class_subject_id]) {
                courseMap[a.class_subject_id].assignments.push({
                    id: a.assignment_id,
                    title: a.assignment_title,
                    deadline: a.deadline,
                    weight: a.weight,
                    submissionId: a.submission_id,
                    grade: a.grade,
                    status: a.submission_status,
                    protestId: a.protest_id,
                    protestStatus: a.protest_status
                });
            }
        });

        // Compute average score per course
        const result = Object.values(courseMap).map(course => {
            const gradedSubmissions = course.assignments.filter(a => a.grade !== null);
            const averageGrade = gradedSubmissions.length > 0
                ? Math.round(gradedSubmissions.reduce((sum, curr) => sum + curr.grade, 0) / gradedSubmissions.length)
                : '—';
            
            return {
                ...course,
                averageGrade
            };
        });

        return res.json(result);
    } catch (err) {
        console.error('Get Student Grade Summary Error:', err);
        return res.status(500).json({ error: `Gagal mengambil ringkasan nilai: ${err.message}` });
    }
});

module.exports = router;
