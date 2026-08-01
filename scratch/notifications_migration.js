const db = require('../config/db');

const migrate = async () => {
    try {
        console.log('Memulai migrasi tabel notifications...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                school_id INT REFERENCES schools(id) ON DELETE CASCADE,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(150) NOT NULL,
                message TEXT NOT NULL,
                type VARCHAR(30) NOT NULL CHECK (type IN ('tugas_baru', 'nilai_masuk', 'sanggahan_selesai', 'pengumuman')),
                link_path VARCHAR(255),
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Tabel notifications berhasil dibuat.');

        // Initialize autoincrement sequence sync
        await db.query(`
            SELECT setval('notifications_id_seq', COALESCE((SELECT MAX(id)+1 FROM notifications), 1), false);
        `);
        console.log('Sinkronisasi sequence tabel notifications sukses.');
        process.exit(0);
    } catch (err) {
        console.error('Migrasi Gagal:', err);
        process.exit(1);
    }
};

migrate();
