const db = require('../config/db');

const migrate = async () => {
    try {
        console.log('Memulai migrasi tabel class_schedules...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS class_schedules (
                id SERIAL PRIMARY KEY,
                school_id INT REFERENCES schools(id) ON DELETE CASCADE,
                class_subject_id INT REFERENCES class_subjects(id) ON DELETE CASCADE,
                day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0: Minggu, 1: Senin, dst.
                start_time TIME NOT NULL,
                end_time TIME NOT NULL,
                room VARCHAR(100) NOT NULL
            );
        `);
        console.log('Tabel class_schedules berhasil dibuat.');

        // Clean old data to avoid duplicate seeds during repeat runs
        await db.query('TRUNCATE TABLE class_schedules RESTART IDENTITY CASCADE');
        console.log('Membersihkan data lama tabel class_schedules.');

        // Seed data
        const seedQuery = `
            INSERT INTO class_schedules (school_id, class_subject_id, day_of_week, start_time, end_time, room)
            VALUES ($1, $2, $3, $4, $5, $6)
        `;

        // 1. Matematika Lanjut (class_subject_id = 1) - Senin: 08:00 - 09:30 (Lab Matematika)
        await db.query(seedQuery, [1, 1, 1, '08:00:00', '09:30:00', 'Lab Matematika']);
        // 2. Matematika Lanjut (class_subject_id = 1) - Kamis: 10:00 - 11:30 (Ruang Kelas XII-IPA2)
        await db.query(seedQuery, [1, 1, 4, '10:00:00', '11:30:00', 'Ruang Kelas XII-IPA2']);
        // 3. Biologi (class_subject_id = 3) - Selasa: 08:00 - 09:30 (Lab Biologi)
        await db.query(seedQuery, [1, 3, 2, '08:00:00', '09:30:00', 'Lab Biologi']);
        // 4. Biologi (class_subject_id = 3) - Jumat: 13:30 - 15:00 (Ruang Kelas XII-IPA2)
        await db.query(seedQuery, [1, 3, 5, '13:30:00', '15:00:00', 'Ruang Kelas XII-IPA2']);

        console.log('Seeding data class_schedules selesai.');
        process.exit(0);
    } catch (err) {
        console.error('Migrasi Gagal:', err);
        process.exit(1);
    }
};

migrate();
