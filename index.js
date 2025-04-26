// index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pool = require('./db');
const authRoutes = require('./routes/auth');
const authenticate = require('./middleware/auth');

const app = express();

// middleware de CORS e JSON
app.use(cors());
app.use(express.json());

// --- MIGRATION: CRIA TABELA users CASO NÃO EXISTA ---
const createUsersTable = `
  CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    email          TEXT   NOT NULL UNIQUE,
    password_hash  TEXT   NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

// Rotas de autenticação
app.use('/auth', authRoutes);
app.get('/', (req, res) => res.send('API NuvemChat online 🚀'));

// Rota protegida de teste DB
app.get('/testdb', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug colunas
app.get('/debug/columns', authenticate, async (req, res) => {
  try {
    const cols = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'messages'
    `);
    res.json(cols.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listagem de mensagens
app.get('/messages', authenticate, async (req, res) => {
  const { tenant_id, channel } = req.query;
  let sql = 'SELECT * FROM messages';
  const params = [];

  if (tenant_id && channel) {
    sql += ' WHERE tenant_id = $1 AND channel = $2';
    params.push(tenant_id, channel);
  } else if (tenant_id) {
    sql += ' WHERE tenant_id = $1'; params.push(tenant_id);
  } else if (channel) {
    sql += ' WHERE channel = $1'; params.push(channel);
  }

  sql += ' ORDER BY id DESC LIMIT 100';

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inserir mensagem manual
app.post('/messages', authenticate, async (req, res) => {
  let { tenant_id, channel, message, timestamp, sender } = req.body;

  // limpa '=' do início
  message = (typeof message === 'string' ? message.replace(/^=/, '') : message);
  sender  = (typeof sender  === 'string' ? sender.replace(/^=/,  '') : sender);

  try {
    const result = await pool.query(
      'INSERT INTO messages (tenant_id, channel, message, timestamp, sender) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [tenant_id, channel, message, timestamp, sender]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook público
app.post('/webhook/message', async (req, res) => {
  let { tenant_id, channel, message, timestamp, sender } = req.body;

  // limpa '=' do início
  message = (typeof message === 'string' ? message.replace(/^=/, '') : message);
  sender  = (typeof sender  === 'string' ? sender.replace(/^=/,  '') : sender);

  try {
    const result = await pool.query(
      'INSERT INTO messages (tenant_id, channel, message, timestamp, sender) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [tenant_id, channel, message, timestamp, sender]
    );
    res.status(201).json({ status: 'success', message: 'Mensagem registrada', data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Migração antes de subir o servidor ---
(async () => {
  try {
    await pool.query(createUsersTable);
    console.log('✅ Tabela "users" pronta');
  } catch (err) {
    console.error('❌ Erro criando tabela users:', err);
  }

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
  });
})();
