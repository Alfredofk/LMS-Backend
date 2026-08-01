const db = require('../config/db');

const check = async () => {
    try {
        console.log('--- DAFTAR SEKOLAH ---');
        const schools = await db.query('SELECT id, name, npsn, school_code FROM schools');
        console.table(schools.rows);

        console.log('\n--- DAFTAR AKUN KEPALA SEKOLAH (HEADMASTER) ---');
        const headmasters = await db.query('SELECT id, username, email, name, role, school_id FROM users WHERE role = \'headmaster\'');
        console.table(headmasters.rows);

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

check();
