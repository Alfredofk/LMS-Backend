const db = require('../config/db');
const bcrypt = require('bcrypt');

const seed = async () => {
    try {
        console.log('Memulai seeding akun Kepala Sekolah...');

        // 1. Sync users_id_seq sequence
        await db.query("SELECT setval('users_id_seq', COALESCE((SELECT MAX(id)+1 FROM users), 1), false)");
        console.log('Sequence users_id_seq berhasil disinkronisasikan.');

        // 2. Check if school_id = 1 exists
        const schoolRes = await db.query("SELECT id, name, npsn FROM schools WHERE id = 1");
        if (schoolRes.rows.length === 0) {
            console.error('Sekolah dengan ID 1 tidak ditemukan.');
            process.exit(1);
        }
        const school = schoolRes.rows[0];

        // 3. Check if headmaster already exists for this school
        const headCheck = await db.query(
            "SELECT id FROM users WHERE school_id = $1 AND role = 'headmaster'",
            [school.id]
        );

        if (headCheck.rows.length > 0) {
            console.log('Akun kepala sekolah untuk sekolah ini sudah terdaftar.');
            process.exit(0);
        }

        // 4. Hash password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash('password123', salt);

        // 5. Insert Headmaster User
        const insertQuery = `
            INSERT INTO users (school_id, username, email, password_hash, name, role)
            VALUES ($1, 'kepsek123', 'kepsek.teladan@sekolah.sch.id', $2, 'Drs. H. Mulyadi, M.Pd.', 'headmaster')
            RETURNING id, username, email, name, role
        `;
        const result = await db.query(insertQuery, [school.id, passwordHash]);
        console.log('Akun Kepala Sekolah berhasil di-seed:');
        console.table(result.rows);

        process.exit(0);
    } catch (err) {
        console.error('Seeding Headmaster Gagal:', err);
        process.exit(1);
    }
};

seed();
