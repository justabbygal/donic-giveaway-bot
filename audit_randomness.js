const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function audit() {
  try {
    // Get all giveaway history
    const result = await pool.query(
      'SELECT id, initial_winners FROM giveaway_history WHERE initial_winners IS NOT NULL AND initial_winners != \'[]\''
    );

    const winCounts = {};
    let totalWins = 0;

    for (const row of result.rows) {
      const winners = JSON.parse(row.initial_winners || '[]');
      for (const winnerId of winners) {
        winCounts[winnerId] = (winCounts[winnerId] || 0) + 1;
        totalWins++;
      }
    }

    console.log('\n📊 WIN DISTRIBUTION AUDIT:\n');
    console.log(`Total giveaways with winners: ${result.rows.length}`);
    console.log(`Total wins distributed: ${totalWins}\n`);

    // Sort by win count
    const sorted = Object.entries(winCounts).sort((a, b) => b[1] - a[1]);

    console.log('🏆 TOP WINNERS:');
    sorted.slice(0, 10).forEach((entry, i) => {
      console.log(`  ${i + 1}. ${entry[0]}: ${entry[1]} wins`);
    });

    console.log('\n⚠️  USERS WITH 0 WINS:');
    // You need to tell me the user ID to check
    const targetId = '788559501468368906';
    if (winCounts[targetId]) {
      console.log(`  ${targetId}: ${winCounts[targetId]} wins`);
    } else {
      console.log(`  ${targetId}: 0 WINS ❌`);
    }

    // Check distribution fairness
    const avgWins = totalWins / sorted.length;
    const maxWins = sorted[0][1];
    const minWins = sorted[sorted.length - 1][1];

    console.log(`\n📈 DISTRIBUTION STATS:`);
    console.log(`  Avg wins per user: ${avgWins.toFixed(2)}`);
    console.log(`  Max wins: ${maxWins}`);
    console.log(`  Min wins: ${minWins}`);
    console.log(`  Spread: ${maxWins - minWins}`);

    if (maxWins > avgWins * 2) {
      console.log(`\n⚠️  WARNING: Distribution is HEAVILY skewed!`);
    }

  } catch (err) {
    console.error('Error:', err.message);
  }
  
  process.exit(0);
}

audit();
