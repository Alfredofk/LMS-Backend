const db = require('../config/db');

const test = async () => {
    try {
        const studentId = 2; // Alfredo
        
        console.log('--- TEST 1: FETCH STUDENT ASSESSMENTS ---');
        const query = `
            SELECT a.id AS "assessmentId", a.title, a.deadline, a.xp_reward AS "xpReward",
                   s.name AS "subjectName", s.code AS "subjectCode",
                   sub.id AS "submissionId", COALESCE(sub.status, 'Belum Mengumpulkan') AS "submissionStatus", 
                   sub.grade, sub.feedback
            FROM assessments a
            JOIN sessions sec ON a.session_id = sec.id
            JOIN class_subjects cs ON sec.class_subject_id = cs.id
            JOIN subjects s ON cs.subject_id = s.id
            JOIN class_enrollments ce ON cs.class_id = ce.class_id
            LEFT JOIN assessment_submissions sub ON a.id = sub.assessment_id AND sub.student_id = $1
            WHERE ce.student_id = $1 AND a.type = 'tugas'
            ORDER BY a.deadline ASC
        `;
        const res = await db.query(query, [studentId]);
        console.log(`Found ${res.rows.length} assessments:`);
        console.table(res.rows);

        console.log('\nDATABASE QUERY VERIFIED SUCCESSFULLY!');
        process.exit(0);
    } catch (e) {
        console.error('Test failed:', e);
        process.exit(1);
    }
};

test();
