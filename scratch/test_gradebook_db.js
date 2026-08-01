const db = require('../db');

async function test() {
  const courseId = 1;
  const school_id = 1;
  const userId = 1;

  try {
    console.log('--- TESTING GRADEBOOK QUERIES ---');
    
    console.log('1. Testing courseCheck...');
    const courseCheck = await db.query(
        `SELECT cs.id 
         FROM class_subjects cs
         JOIN classes c ON cs.class_id = c.id
         WHERE cs.id = $1 AND c.school_id = $2 AND cs.teacher_id = $3`, 
        [courseId, school_id, userId]
    );
    console.log('   Results:', courseCheck.rows);

    if (courseCheck.rows.length === 0) {
      console.log('   Warning: Course check returned 0 rows! This is why it throws 404/authorization error.');
      return;
    }

    console.log('2. Testing assignments query...');
    const assignmentsRes = await db.query(
        `SELECT a.id, a.title, COALESCE(a.weight, 0) as weight
         FROM assessments a
         JOIN sessions s ON a.session_id = s.id
         WHERE s.class_subject_id = $1 AND a.type = 'tugas'
         ORDER BY a.id ASC`,
        [courseId]
    );
    console.log('   Count:', assignmentsRes.rows.length);

    console.log('3. Testing students query...');
    const studentsRes = await db.query(
        `SELECT u.id, u.name, u.nis, u.email
         FROM users u
         JOIN class_enrollments ce ON u.id = ce.student_id
         JOIN class_subjects cs ON ce.class_id = cs.class_id
         WHERE cs.id = $1 AND u.school_id = $2
         ORDER BY u.name ASC`,
        [courseId, school_id]
    );
    console.log('   Count:', studentsRes.rows.length);

    console.log('4. Testing submissions query...');
    const submissionsRes = await db.query(
        `SELECT s.student_id, s.assessment_id, s.grade
         FROM assessment_submissions s
         JOIN assessments a ON s.assessment_id = a.id
         JOIN sessions sec ON a.session_id = sec.id
         WHERE sec.class_subject_id = $1 AND a.type = 'tugas'`,
        [courseId]
    );
    console.log('   Count:', submissionsRes.rows.length);

    console.log('--- ALL QUERIES SUCCEEDED ---');
  } catch (err) {
    console.error('Error during query testing:', err);
  } finally {
    process.exit();
  }
}

test();
