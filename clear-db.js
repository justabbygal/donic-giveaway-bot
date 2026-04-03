const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
});

pool.query('DELETE FROM active_giveaway')
  .then(() => {
    console.log('✅ active_giveaway table cleared');
  })
  .catch((err) => {
    console.error('Error clearing table:', err);
  })
  .finally(() => {
    pool.end();
    process.exit(0);
  });
