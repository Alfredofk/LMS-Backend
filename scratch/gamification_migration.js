const db = require('../db');

async function migrate() {
  try {
    console.log('Starting gamification database schema creation...');

    // 1. Create student_gamification
    await db.query(`
      CREATE TABLE IF NOT EXISTS student_gamification (
          student_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          xp INT DEFAULT 0,
          level INT DEFAULT 1,
          daily_streak INT DEFAULT 0,
          task_streak INT DEFAULT 0,
          last_active_date DATE DEFAULT CURRENT_DATE
      );
    `);
    console.log('- Created student_gamification table.');

    // 2. Create xp_transactions
    await db.query(`
      CREATE TABLE IF NOT EXISTS xp_transactions (
          id SERIAL PRIMARY KEY,
          student_id INT REFERENCES users(id) ON DELETE CASCADE,
          amount INT NOT NULL,
          source_type VARCHAR(50) NOT NULL,
          source_id INT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('- Created xp_transactions table.');

    // 3. Create badge_definitions
    await db.query(`
      CREATE TABLE IF NOT EXISTS badge_definitions (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT NOT NULL,
          criteria_type VARCHAR(50) NOT NULL CHECK (criteria_type IN ('level', 'xp', 'streak')),
          criteria_value INT NOT NULL,
          icon VARCHAR(50) NOT NULL
      );
    `);
    console.log('- Created badge_definitions table.');

    // 4. Create student_badges
    await db.query(`
      CREATE TABLE IF NOT EXISTS student_badges (
          student_id INT REFERENCES users(id) ON DELETE CASCADE,
          badge_id INT REFERENCES badge_definitions(id) ON DELETE CASCADE,
          unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (student_id, badge_id)
      );
    `);
    console.log('- Created student_badges table.');

    console.log('\nSeeding default badge definitions and starting student levels...');

    // Seed badge_definitions if empty
    const checkBadges = await db.query('SELECT COUNT(*) FROM badge_definitions');
    if (parseInt(checkBadges.rows[0].count, 10) === 0) {
      await db.query(`
        INSERT INTO badge_definitions (name, description, criteria_type, criteria_value, icon)
        VALUES 
          ('Murid Berbakat', 'Berhasil naik ke level 2 setelah menyelesaikan tantangan akademik.', 'level', 2, 'Award'),
          ('Pengumpul XP Ulung', 'Berhasil mengumpulkan akumulasi total 1000 XP.', 'xp', 1000, 'Zap'),
          ('Konsistensi Tinggi', 'Memiliki streak kehadiran harian minimal 5 hari berturut-turut.', 'streak', 5, 'Flame')
      `);
      console.log('- Seeded 3 default badge definitions.');
    }

    // Seed student_gamification for existing students (Alfredo: id 2, Siti: id 3)
    await db.query(`
      INSERT INTO student_gamification (student_id, xp, level, daily_streak, task_streak, last_active_date)
      VALUES 
        (2, 850, 1, 3, 1, CURRENT_DATE),
        (3, 450, 1, 1, 0, CURRENT_DATE)
      ON CONFLICT (student_id) DO UPDATE 
      SET xp = EXCLUDED.xp, level = EXCLUDED.level, daily_streak = EXCLUDED.daily_streak;
    `);
    console.log('- Seeded student gamification states.');

    // Update users table columns to sync starting XP/Level
    await db.query(`
      UPDATE users SET xp = 850, level = 1 WHERE id = 2;
      UPDATE users SET xp = 450, level = 1 WHERE id = 3;
    `);
    console.log('- Synchronized users table with starting stats.');

    // Seed initial xp_transactions
    await db.query('DELETE FROM xp_transactions');
    await db.query(`
      INSERT INTO xp_transactions (student_id, amount, source_type, source_id)
      VALUES 
        (2, 765, 'starting', 0),
        (2, 85, 'tugas', 1),
        (3, 450, 'starting', 0)
    `);
    console.log('- Seeded starting XP transactions.');

    // Sync sequences
    await db.query(`
      SELECT setval('badge_definitions_id_seq', COALESCE((SELECT MAX(id)+1 FROM badge_definitions), 1), false);
      SELECT setval('xp_transactions_id_seq', COALESCE((SELECT MAX(id)+1 FROM xp_transactions), 1), false);
    `);

    console.log('Gamification database schema migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    process.exit();
  }
}

migrate();
