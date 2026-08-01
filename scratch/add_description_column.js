const db = require('../config/db');

const addColumn = async () => {
    try {
        console.log('Menambahkan kolom description pada tabel subjects...');
        await db.query(`
            ALTER TABLE subjects 
            ADD COLUMN IF NOT EXISTS description TEXT;
        `);
        console.log('Kolom description berhasil ditambahkan.');
        process.exit(0);
    } catch (err) {
        console.error('Gagal menambahkan kolom:', err);
        process.exit(1);
    }
};

addColumn();
