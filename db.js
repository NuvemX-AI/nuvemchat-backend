// db.js
const { Pool } = require('pg');

// Garante que a variável de ambiente esteja definida
if (!process.env.DATABASE_URL) {
  throw new Error('❌ DATABASE_URL não está definida nas variáveis de ambiente!');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

module.exports = pool;
