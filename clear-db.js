const sqlite3 = require('sqlite3').verbose();
const dotenv = require('dotenv');

dotenv.config();

const dbPath = process.env.DATABASE_PATH || './giveaway.db';
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database error:', err);
    process.exit(1);
  }
});

db.run('DELETE FROM active_giveaway', function(err) {
  if (err) {
    console.error('Error clearing table:', err);
  } else {
    console.log('✅ active_giveaway table cleared');
  }
  db.close();
  process.exit(0);
});
