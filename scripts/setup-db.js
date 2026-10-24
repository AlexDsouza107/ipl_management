// Creates the ipl_management database (if missing) and runs the 4 SQL files.
// Usage:  npm run db:setup
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const url = new URL(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ipl_management');
const dbName = url.pathname.slice(1) || 'ipl_management';

async function main() {
  // 1. create the database if it does not exist (connect to the default "postgres" db)
  const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!exists.rowCount) {
    await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
    console.log(`Created database ${dbName}`);
  }
  await admin.end();

  // 2. run the SQL files in order
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  db.on('notice', () => {});               // hide DROP ... IF EXISTS notices
  for (const f of ['schema.sql', 'triggers.sql', 'views.sql', 'seed.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8');
    await db.query(sql);
    console.log('Ran', f);
  }
  await db.end();
  console.log('Done. Start the app with:  npm start');
}
main().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
