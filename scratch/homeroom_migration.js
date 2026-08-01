const db = require('../config/db');

const migrate = async () => {
    try {
        console.log('Memulai migrasi kolom homeroom_teacher_id...');
        await db.query(`
            ALTER TABLE classes ADD COLUMN IF NOT EXISTS homeroom_teacher_id INT REFERENCES users(id) ON DELETE SET NULL;
        `);
        console.log('Kolom homeroom_teacher_id berhasil ditambahkan.');

        // Assign teacher123 (usually ID 1) as Homeroom Teacher of XII IPA 2
        const teacherRes = await db.query("SELECT id FROM users WHERE username = 'teacher123' AND role = 'teacher'");
        const classRes = await db.query("SELECT id FROM classes WHERE name = 'XII IPA 2'");

        if (teacherRes.rows.length > 0 && classRes.rows.length > 0) {
            const teacherId = teacherRes.rows[0].id;
            const classId = classRes.rows[0].id;

            await db.query(
                "UPDATE classes SET homeroom_teacher_id = $1 WHERE id = $2",
                [teacherId, classId]
            );
            console.log(`Berhasil menetapkan Guru ID ${teacherId} sebagai Wali Kelas XII IPA 2 (Class ID ${classId}).`);
        } else {
            console.warn('Peringatan: Guru teacher123 atau Kelas XII IPA 2 tidak ditemukan. Penetapan wali kelas dilewati.');
        }

        process.exit(0);
    } catch (err) {
        console.error('Migrasi Homeroom Gagal:', err);
        process.exit(1);
    }
};

migrate();
