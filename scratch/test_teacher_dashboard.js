const db = require('../db');

async function test() {
  const teacherId = 1;
  const schoolId = 1;

  try {
    console.log('--- TESTING TEACHER DASHBOARD BACKEND QUERIES ---');
    
    console.log('1. Testing total classes count...');
    const classesCountRes = await db.query(
        `SELECT COUNT(*) FROM class_subjects cs
         JOIN classes c ON cs.class_id = c.id
         WHERE cs.teacher_id = $1 AND c.school_id = $2`,
        [teacherId, schoolId]
    );
    console.log('   Classes Count:', classesCountRes.rows[0].count);

    console.log('2. Testing unique students count...');
    const studentsCountRes = await db.query(
        `SELECT COUNT(DISTINCT ce.student_id) 
         FROM class_enrollments ce 
         JOIN class_subjects cs ON ce.class_id = cs.class_id 
         JOIN classes c ON cs.class_id = c.id
         WHERE cs.teacher_id = $1 AND c.school_id = $2`,
        [teacherId, schoolId]
    );
    console.log('   Students Count:', studentsCountRes.rows[0].count);

    console.log('3. Testing pending grading submissions count...');
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
    console.log('   Pending Grading Count:', pendingGradingRes.rows[0].count);

    console.log('4. Testing recent submissions list...');
    const submissionsRes = await db.query(
        `SELECT s.id, u.name AS student_name, c.name AS grade_level, a.title AS assignment_title, s.created_at
         FROM assessment_submissions s
         JOIN users u ON s.student_id = u.id
         JOIN assessments a ON s.assessment_id = a.id
         JOIN sessions sec ON a.session_id = sec.id
         JOIN class_subjects cs ON sec.class_subject_id = cs.id
         JOIN classes c ON cs.class_id = c.id
         WHERE cs.teacher_id = $1 AND u.school_id = $2
         ORDER BY s.created_at DESC
         LIMIT 5`,
        [teacherId, schoolId]
    );
    console.log('   Recent Submissions count:', submissionsRes.rows.length);
    if (submissionsRes.rows.length > 0) {
      console.log('   First item:', submissionsRes.rows[0]);
    }

    console.log('--- ALL QUERIES SUCCEEDED ---');
  } catch (err) {
    console.error('Query testing failed:', err);
  } finally {
    process.exit();
  }
}

test();
