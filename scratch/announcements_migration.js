const db = require('../config/db');

const migrate = async () => {
    try {
        console.log('Memulai migrasi tabel announcements...');
        await db.query(`
            CREATE TABLE IF NOT EXISTS announcements (
                id SERIAL PRIMARY KEY,
                school_id INT REFERENCES schools(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                content TEXT NOT NULL,
                author_id INT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Tabel announcements berhasil dibuat.');

        // Insert a default announcement if none exists
        const countRes = await db.query("SELECT COUNT(*) FROM announcements");
        if (parseInt(countRes.rows[0].count, 10) === 0) {
            const headmasterRes = await db.query("SELECT id FROM users WHERE role = 'headmaster' AND school_id = 1 LIMIT 1");
            const authorId = headmasterRes.rows.length > 0 ? headmasterRes.rows[0].id : null;

            await db.query(
                `INSERT INTO announcements (school_id, title, content, author_id)
                 VALUES (1, 'Selamat Datang di Portal KelasKita!', 'Halo seluruh siswa dan guru SMA Negeri 1 Harapan. Selamat beraktivitas di portal pembelajaran baru kita. Jangan lupa untuk melakukan check-in absensi kehadiran harian Anda untuk memperoleh poin XP!', $1)`,
                [authorId]
            );
            console.log('Pengumuman pembuka sekolah berhasil di-seed.');
        }

        process.exit(0);
    } catch (err) {
        console.error('Migrasi Announcements Gagal:', err);
        process.exit(1);
    }
};

migrate();
