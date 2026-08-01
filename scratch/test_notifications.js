const db = require('../config/db');

const test = async () => {
    try {
        const schoolId = 1;
        const studentId = 2; // Alfredo
        
        console.log('--- TEST 1: INSERT MOCK NOTIFICATION ---');
        const insertQuery = `
            INSERT INTO notifications (school_id, user_id, title, message, type, link_path)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `;
        const result = await db.query(insertQuery, [
            schoolId, 
            studentId, 
            'Tugas Baru: Uji Fungsionalitas', 
            'Silakan kerjakan latihan bab 5 sebelum tenggat waktu.', 
            'tugas_baru', 
            '/classroom'
        ]);
        const newNotif = result.rows[0];
        console.log('Inserted Notification:', newNotif);

        console.log('\n--- TEST 2: FETCH NOTIFICATIONS ---');
        const listQuery = `
            SELECT id, title, message, is_read 
            FROM notifications 
            WHERE school_id = $1 AND user_id = $2 
            ORDER BY id DESC 
            LIMIT 5
        `;
        const listRes = await db.query(listQuery, [schoolId, studentId]);
        console.table(listRes.rows);

        console.log('\n--- TEST 3: MARK AS READ ---');
        const updateQuery = `
            UPDATE notifications 
            SET is_read = TRUE 
            WHERE id = $1 AND user_id = $2 
            RETURNING id, is_read
        `;
        const updateRes = await db.query(updateQuery, [newNotif.id, studentId]);
        console.log('Updated Notification Status:', updateRes.rows[0]);

        console.log('\n--- TEST 4: CLEAN UP MOCK NOTIFICATION ---');
        await db.query('DELETE FROM notifications WHERE id = $1', [newNotif.id]);
        console.log('Cleanup successful.');

        console.log('\nALL DB TESTS COMPLETED SUCCESSFULLY!');
        process.exit(0);
    } catch (err) {
        console.error('Test Failed:', err);
        process.exit(1);
    }
};

test();
