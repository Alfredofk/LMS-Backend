const db = require('../config/db');

const test = async () => {
    try {
        const studentId = 2; // Alfredo
        const teacherId = 1; // Budi Santoso
        const schoolId = 1;

        console.log('--- TEST 1: FETCH STUDENT SCHEDULES & DEADLINES ---');
        const schRes = await db.query(`
            SELECT sch.id, sch.day_of_week AS "dayOfWeek", sch.start_time AS "startTime", sch.end_time AS "endTime", sch.room,
                   s.name AS "subjectName", s.code AS "subjectCode", u.name AS "teacherName"
            FROM class_schedules sch
            JOIN class_subjects cs ON sch.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN users u ON cs.teacher_id = u.id
            WHERE sch.school_id = $1 AND cs.class_id = (
                SELECT class_id FROM class_enrollments WHERE student_id = $2 LIMIT 1
            )
            ORDER BY sch.day_of_week ASC
        `, [schoolId, studentId]);
        console.log('Weekly schedules for student:');
        console.table(schRes.rows);

        const dlRes = await db.query(`
            SELECT a.id, a.title, a.deadline, s.name AS "subjectName"
            FROM assessments a
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN class_enrollments ce ON cs.class_id = ce.class_id
            WHERE ce.student_id = $1 AND a.type = 'tugas'
        `, [studentId]);
        console.log('Deadlines for student:');
        console.table(dlRes.rows);

        console.log('\n--- TEST 2: FETCH TEACHER SCHEDULES & DEADLINES ---');
        const teachSchRes = await db.query(`
            SELECT sch.id, sch.day_of_week AS "dayOfWeek", sch.start_time AS "startTime", sch.end_time AS "endTime", sch.room,
                   s.name AS "subjectName", s.code AS "subjectCode", c.name AS "className"
            FROM class_schedules sch
            JOIN class_subjects cs ON sch.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN classes c ON cs.class_id = c.id
            WHERE sch.school_id = $1 AND cs.teacher_id = $2
        `, [schoolId, teacherId]);
        console.log('Weekly schedules for teacher:');
        console.table(teachSchRes.rows);

        console.log('\nALL DATABASE QUERIES VERIFIED SUCCESSFULLY!');
        process.exit(0);
    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    }
};

test();
