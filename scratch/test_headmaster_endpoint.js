const db = require('../config/db');

// Simulate the SQL query run by GET /api/headmaster/teachers for school_id = 1
const test = async () => {
    try {
        const schoolId = 1;
        const result = await db.query(
            "SELECT id, name, username, email, nip, created_at FROM users WHERE role = 'teacher' AND school_id = $1 ORDER BY name ASC",
            [schoolId]
        );
        console.log('--- HASIL ENDPOINT GET /api/headmaster/teachers (school_id = 1) ---');
        console.table(result.rows);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

test();
