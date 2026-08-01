const db = require('../config/db');

const check = async () => {
    try {
        console.log('--- DAFTAR GURU DI DATABASE ---');
        const res = await db.query("SELECT id, name, username, email, role, nip, school_id FROM users WHERE role = 'teacher'");
        console.table(res.rows);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

check();
