const db = require('../db');

async function inspect() {
  try {
    const tablesRes = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name ASC
    `);
    console.log('--- TABLES IN DATABASE ---');
    console.log(tablesRes.rows.map(r => r.table_name));
    
    for (let table of tablesRes.rows) {
      const colsRes = await db.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position ASC
      `, [table.table_name]);
      console.log(`\nTable [${table.table_name}]:`);
      console.log(colsRes.rows.map(r => `  - ${r.column_name} (${r.data_type})`).join('\n'));
    }
  } catch (err) {
    console.error('Error during database inspection:', err);
  } finally {
    process.exit();
  }
}

inspect();
