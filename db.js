const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Log connection errors (but don't crash — queries will fail individually)
pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
