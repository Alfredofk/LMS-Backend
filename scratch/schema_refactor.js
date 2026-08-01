const db = require('../db');

async function migrate() {
  try {
    console.log('Starting database schema migration...');

    // 1. Drop existing tables
    await db.query(`
      DROP TABLE IF EXISTS submissions CASCADE;
      DROP TABLE IF EXISTS assignments CASCADE;
      DROP TABLE IF EXISTS materials CASCADE;
      DROP TABLE IF EXISTS sections CASCADE;
      DROP TABLE IF EXISTS enrollments CASCADE;
      DROP TABLE IF EXISTS courses CASCADE;

      DROP TABLE IF EXISTS assessment_submissions CASCADE;
      DROP TABLE IF EXISTS assessments CASCADE;
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS class_enrollments CASCADE;
      DROP TABLE IF EXISTS class_subjects CASCADE;
      DROP TABLE IF EXISTS subjects CASCADE;
      DROP TABLE IF EXISTS classes CASCADE;
      DROP TABLE IF EXISTS academic_years CASCADE;
    `);
    console.log('- Dropped old tables.');

    // 2. Create academic_years
    await db.query(`
      CREATE TABLE academic_years (
          id SERIAL PRIMARY KEY,
          school_id INT REFERENCES schools(id) ON DELETE CASCADE,
          year_name VARCHAR(50) NOT NULL,
          semester VARCHAR(20) NOT NULL CHECK (semester IN ('Ganjil', 'Genap')),
          status VARCHAR(20) DEFAULT 'non-aktif' CHECK (status IN ('aktif', 'non-aktif'))
      );
    `);
    console.log('- Created academic_years table.');

    // 3. Create classes
    await db.query(`
      CREATE TABLE classes (
          id SERIAL PRIMARY KEY,
          school_id INT REFERENCES schools(id) ON DELETE CASCADE,
          academic_year_id INT REFERENCES academic_years(id) ON DELETE SET NULL,
          name VARCHAR(50) NOT NULL,
          homeroom_teacher_id INT REFERENCES users(id) ON DELETE SET NULL
      );
    `);
    console.log('- Created classes table.');

    // 4. Create subjects
    await db.query(`
      CREATE TABLE subjects (
          id SERIAL PRIMARY KEY,
          school_id INT REFERENCES schools(id) ON DELETE CASCADE,
          name VARCHAR(150) NOT NULL,
          code VARCHAR(50) NOT NULL
      );
    `);
    console.log('- Created subjects table.');

    // 5. Create class_subjects
    await db.query(`
      CREATE TABLE class_subjects (
          id SERIAL PRIMARY KEY,
          class_id INT REFERENCES classes(id) ON DELETE CASCADE,
          subject_id INT REFERENCES subjects(id) ON DELETE CASCADE,
          teacher_id INT REFERENCES users(id) ON DELETE SET NULL,
          passing_grade INT DEFAULT 75,
          weight_task INT DEFAULT 40,
          weight_uts INT DEFAULT 30,
          weight_uas INT DEFAULT 30
      );
    `);
    console.log('- Created class_subjects table.');

    // 6. Create class_enrollments
    await db.query(`
      CREATE TABLE class_enrollments (
          student_id INT REFERENCES users(id) ON DELETE CASCADE,
          class_id INT REFERENCES classes(id) ON DELETE CASCADE,
          is_approved BOOLEAN DEFAULT TRUE,
          PRIMARY KEY (student_id, class_id)
      );
    `);
    console.log('- Created class_enrollments table.');

    // 7. Create sessions
    await db.query(`
      CREATE TABLE sessions (
          id SERIAL PRIMARY KEY,
          class_subject_id INT REFERENCES class_subjects(id) ON DELETE CASCADE,
          title VARCHAR(100) NOT NULL,
          sequence_order INT NOT NULL
      );
    `);
    console.log('- Created sessions table.');

    // 8. Create materials
    await db.query(`
      CREATE TABLE materials (
          id SERIAL PRIMARY KEY,
          session_id INT REFERENCES sessions(id) ON DELETE CASCADE,
          title VARCHAR(200) NOT NULL,
          type VARCHAR(20) NOT NULL DEFAULT 'pdf',
          size VARCHAR(50) DEFAULT '2.0 MB',
          description TEXT
      );
    `);
    console.log('- Created materials table.');

    // 9. Create assessments
    await db.query(`
      CREATE TABLE assessments (
          id SERIAL PRIMARY KEY,
          session_id INT REFERENCES sessions(id) ON DELETE CASCADE,
          title VARCHAR(200) NOT NULL,
          type VARCHAR(30) NOT NULL CHECK (type IN ('tugas', 'kuis', 'uts', 'uas')),
          deadline TIMESTAMP NOT NULL,
          xp_reward INT DEFAULT 100,
          description TEXT NOT NULL,
          weight INT DEFAULT 0
      );
    `);
    console.log('- Created assessments table.');

    // 10. Create assessment_submissions
    await db.query(`
      CREATE TABLE assessment_submissions (
          id SERIAL PRIMARY KEY,
          assessment_id INT REFERENCES assessments(id) ON DELETE CASCADE,
          student_id INT REFERENCES users(id) ON DELETE CASCADE,
          submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          file_url VARCHAR(255) NOT NULL DEFAULT '',
          file_name VARCHAR(150) NOT NULL DEFAULT '',
          grade INT CHECK (grade >= 0 AND grade <= 100),
          feedback TEXT,
          status VARCHAR(30) DEFAULT 'Belum Dinilai' CHECK (status IN ('Belum Mengumpulkan', 'Terkumpul', 'Belum Dinilai', 'Sudah Dinilai'))
      );
    `);
    console.log('- Created assessment_submissions table.');

    console.log('\nSeeding new mock records into database...');

    // Seed academic_years
    await db.query(`
      INSERT INTO academic_years (school_id, year_name, semester, status)
      VALUES (1, '2026/2027', 'Ganjil', 'aktif');
    `);

    // Seed classes
    // homeroom_teacher_id = 1 (Budi Santoso, S.Pd.)
    await db.query(`
      INSERT INTO classes (school_id, academic_year_id, name, homeroom_teacher_id)
      VALUES (1, 1, 'XII IPA 2', 1);
    `);

    // Seed subjects
    await db.query(`
      INSERT INTO subjects (school_id, name, code)
      VALUES (1, 'Matematika Lanjut', 'MAT-XII-L');
    `);

    // Seed class_subjects
    await db.query(`
      INSERT INTO class_subjects (class_id, subject_id, teacher_id, passing_grade, weight_task, weight_uts, weight_uas)
      VALUES (1, 1, 1, 75, 40, 30, 30);
    `);

    // Seed class_enrollments (Alfredo: 2, Siti Rahma: 3 enrolled in class 1)
    await db.query(`
      INSERT INTO class_enrollments (student_id, class_id, is_approved) 
      VALUES 
        (2, 1, TRUE),
        (3, 1, TRUE);
    `);

    // Seed sessions
    await db.query(`
      INSERT INTO sessions (class_subject_id, title, sequence_order)
      VALUES (1, 'Pertemuan 1: Limit Fungsi Trigonometri', 1);
    `);

    // Seed materials
    await db.query(`
      INSERT INTO materials (session_id, title, type, size, description)
      VALUES 
        (1, 'Modul Limit Trigonometri Dasar.pdf', 'pdf', '2.4 MB', 'Pelajari konsep dasar limit fungsi trigonometri beserta pembahasannya.'),
        (1, 'Video Penjelasan Limit Trigonometri.mp4', 'video', '15.8 MB', 'Tonton video penjelasan visual mengenai penyelesaian persamaan limit.');
    `);

    // Seed assessments
    await db.query(`
      INSERT INTO assessments (session_id, title, type, deadline, xp_reward, description, weight)
      VALUES 
        (1, 'Latihan Soal Limit Trigonometri', 'tugas', '2026-07-25 23:59:59', 150, 'Kerjakan latihan soal halaman 45 nomor 1-10 di buku latihan.', 50),
        (1, 'Tugas Mandiri Turunan Trigonometri', 'tugas', '2026-07-30 23:59:59', 100, 'Selesaikan soal turunan yang dilampirkan pada file materi.', 50);
    `);

    // Seed assessment_submissions
    await db.query(`
      INSERT INTO assessment_submissions (assessment_id, student_id, file_url, file_name, status, grade, feedback)
      VALUES (1, 2, '/uploads/alfredo_limit_trig.pdf', 'Jawaban_Limit_Trig_Alfredo.pdf', 'Sudah Dinilai', 85, 'Kerja bagus, pertahankan!');

      INSERT INTO assessment_submissions (assessment_id, student_id, file_url, file_name, status)
      VALUES (1, 3, '/uploads/siti_limit_trig.pdf', 'Siti_Limit_Tugas1.pdf', 'Belum Dinilai');
    `);

    // Sync sequences
    await db.query(`
      SELECT setval('academic_years_id_seq', COALESCE((SELECT MAX(id)+1 FROM academic_years), 1), false);
      SELECT setval('classes_id_seq', COALESCE((SELECT MAX(id)+1 FROM classes), 1), false);
      SELECT setval('subjects_id_seq', COALESCE((SELECT MAX(id)+1 FROM subjects), 1), false);
      SELECT setval('class_subjects_id_seq', COALESCE((SELECT MAX(id)+1 FROM class_subjects), 1), false);
      SELECT setval('sessions_id_seq', COALESCE((SELECT MAX(id)+1 FROM sessions), 1), false);
      SELECT setval('materials_id_seq', COALESCE((SELECT MAX(id)+1 FROM materials), 1), false);
      SELECT setval('assessments_id_seq', COALESCE((SELECT MAX(id)+1 FROM assessments), 1), false);
      SELECT setval('assessment_submissions_id_seq', COALESCE((SELECT MAX(id)+1 FROM assessment_submissions), 1), false);
    `);

    console.log('Database migration & seeding completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    process.exit();
  }
}

migrate();
