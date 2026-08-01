const db = require('../db');

async function check() {
  try {
    const res = await db.query('SELECT id, name, email, role FROM users');
    console.log('--- USERS IN DATABASE ---');
    console.table(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

check();
