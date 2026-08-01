const db = require('../db');

async function migrate() {
  try {
    console.log('Starting grade protests database schema creation...');

    // 1. Create grade_protests table
    await db.query(`
      CREATE TABLE IF NOT EXISTS grade_protests (
          id SERIAL PRIMARY KEY,
          submission_id INT REFERENCES assessment_submissions(id) ON DELETE CASCADE,
          student_id INT REFERENCES users(id) ON DELETE CASCADE,
          reason TEXT NOT NULL,
          requested_grade INT CHECK (requested_grade >= 0 AND requested_grade <= 100),
          status VARCHAR(30) DEFAULT 'Pending' CHECK (status IN ('Pending', 'Disetujui', 'Ditolak')),
          teacher_feedback TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('- Created grade_protests table.');

    // 2. Seed a sample protest
    // Get Alfredo's graded submission for limit trigonometry (assessment 1)
    const subRes = await db.query(
        'SELECT id FROM assessment_submissions WHERE student_id = 2 AND assessment_id = 1 LIMIT 1'
    );

    if (subRes.rows.length > 0) {
      const subId = subRes.rows[0].id;
      
      // Clear existing protests to avoid duplicate key issues
      await db.query('DELETE FROM grade_protests');

      await db.query(`
        INSERT INTO grade_protests (submission_id, student_id, reason, requested_grade, status)
        VALUES ($1, 2, 'Kalkulasi nomor 4 saya rasa sudah benar sesuai petunjuk di halaman 3.', 95, 'Pending')
      `, [subId]);
      console.log('- Seeded 1 sample pending protest for student Alfredo.');
    }

    // Sync sequences
    await db.query(`
      SELECT setval('grade_protests_id_seq', COALESCE((SELECT MAX(id)+1 FROM grade_protests), 1), false);
    `);
    
    console.log('Grade protests database schema migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    process.exit();
  }
}

migrate();
