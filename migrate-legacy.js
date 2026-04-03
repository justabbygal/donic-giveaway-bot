/**
 * One-time migration: reassign all rows with guild_id = 'legacy' to the real guild ID.
 *
 * Usage:
 *   LEGACY_GUILD_ID=1414675644750626910 node migrate-legacy.js
 *
 * Or set it in the script directly (see REAL_GUILD_ID below).
 */

const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const REAL_GUILD_ID = process.env.LEGACY_GUILD_ID || '1414675644750626910';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : false,
});

const TABLES = ['user_map', 'eligibility_cache', 'active_giveaway', 'templates', 'giveaway_history', 'xp_records', 'ban_list'];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const table of TABLES) {
      // Check if the table exists before trying to update it
      const exists = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
        [table]
      );
      if (exists.rowCount === 0) {
        console.log(`⏭️  Skipping ${table} (table does not exist)`);
        continue;
      }

      // Check if guild_id column exists
      const hasColumn = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'guild_id'`,
        [table]
      );
      if (hasColumn.rowCount === 0) {
        console.log(`⏭️  Skipping ${table} (no guild_id column)`);
        continue;
      }

      const result = await client.query(
        `UPDATE ${table} SET guild_id = $1 WHERE guild_id = 'legacy'`,
        [REAL_GUILD_ID]
      );
      console.log(`✅ ${table}: updated ${result.rowCount} row(s)`);
    }

    await client.query('COMMIT');
    console.log('\n🎉 Migration complete. All legacy rows now use guild_id:', REAL_GUILD_ID);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed, rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
