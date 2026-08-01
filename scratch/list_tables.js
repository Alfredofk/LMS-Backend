const db = require('../config/db');

const list = async () => {
    try {
        const res = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
        console.table(res.rows);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

list();
