const db = require('../db');

async function check() {
  try {
    const res = await db.query('SELECT id, name, school_code FROM schools');
    console.log('--- SCHOOLS IN DATABASE ---');
    console.table(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

check();
