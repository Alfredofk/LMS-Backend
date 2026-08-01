const db = require('../config/db');

const run = async () => {
    try {
        const cs = await db.query(`
            SELECT cs.id, c.name AS class_name, s.name AS subject_name, s.code AS subject_code
            FROM class_subjects cs
            JOIN classes c ON cs.class_id = c.id
            JOIN subjects s ON cs.subject_id = s.id
        `);
        console.log('Class Subjects mapping:');
        console.table(cs.rows);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

run();
