const db = require('../config/db');

const migrate = async () => {
    try {
        console.log('Memulai migrasi tabel attendances...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS attendances (
                id SERIAL PRIMARY KEY,
                class_subject_id INT REFERENCES class_subjects(id) ON DELETE CASCADE,
                student_id INT REFERENCES users(id) ON DELETE CASCADE,
                date DATE NOT NULL DEFAULT CURRENT_DATE,
                status VARCHAR(20) NOT NULL CHECK (status IN ('Hadir', 'Izin', 'Sakit', 'Alpa')),
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (class_subject_id, student_id, date)
            );
        `);
        console.log('Tabel attendances berhasil dibuat.');

        // Initialize autoincrement sequence sync
        await db.query(`
            SELECT setval('attendances_id_seq', COALESCE((SELECT MAX(id)+1 FROM attendances), 1), false);
        `);
        console.log('Sinkronisasi sequence tabel attendances sukses.');
        process.exit(0);
    } catch (err) {
        console.error('Migrasi Gagal:', err);
        process.exit(1);
    }
};

migrate();
