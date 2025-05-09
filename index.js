// index.js
require('dotenv').config();                     // carrega INSTAGRAM_*, VERIFY_TOKEN etc.

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const pool    = require('./db');

const authRoutes      = require('./routes/auth');
const instagramRoutes = require('./routes/instagram'); // suas rotas corrigidas
const authenticate    = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json());

// --- MIGRATIONS: cria as tabelas se não existirem ---
const createUsersTable = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

const createMessagesTable = `
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    sender TEXT NOT NULL,
    sender_username TEXT,
    sender_profile_picture TEXT
  );
`;

// --- ROTAS PÚBLICAS ---
app.use('/auth', authRoutes);

// --- ROTAS DO INSTAGRAM (OAuth + Webhook) ---
app.use('/api', instagramRoutes);

// --- Health check ---
app.get('/', (_req, res) => res.send('API NuvemChat online 🚀'));

// --- Teste de conexão com banco (protected) ---
app.get('/testdb', authenticate, async (_req, res) => {
  const { rows } = await pool.query('SELECT NOW()');
  res.json(rows[0]);
});

// --- Debug colunas da tabela messages (protected) ---
app.get('/debug/columns', authenticate, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_name = 'messages';
  `);
  res.json(rows);
});

// --- Listar mensagens (protected) ---
app.get('/messages', authenticate, async (req, res) => {
  const { tenant_id, channel } = req.query;
  let sql = 'SELECT * FROM messages';
  const params = [];

  if (tenant_id && channel) {
    sql   += ' WHERE tenant_id = $1 AND channel = $2';
    params.push(tenant_id, channel);
  } else if (tenant_id) {
    sql   += ' WHERE tenant_id = $1';
    params.push(tenant_id);
  } else if (channel) {
    sql   += ' WHERE channel = $1';
    params.push(channel);
  }

  sql += ' ORDER BY id DESC LIMIT 100';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// --- Inserir mensagem manual (protected) ---
app.post('/messages', authenticate, async (req, res) => {
  let { tenant_id, channel, message, timestamp, sender } = req.body;
  message = typeof message === 'string' ? message.replace(/^=/, '') : message;
  sender  = typeof sender  === 'string' ? sender.replace(/^=/, '')  : sender;

  const { rows } = await pool.query(
    `INSERT INTO messages
       (tenant_id, channel, message, timestamp, sender)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [tenant_id, channel, message, timestamp, sender]
  );
  res.status(201).json(rows[0]);
});

// --- Webhook de mensagens externas (ex: n8n) ---
app.post('/webhook/message', async (req, res) => {
  let { tenant_id, channel, message, timestamp, sender } = req.body;
  message = typeof message === 'string' ? message.replace(/^=/, '') : message;
  sender  = typeof sender  === 'string' ? sender.replace(/^=/, '')  : sender;

  const { rows } = await pool.query(
    `INSERT INTO messages
       (tenant_id, channel, message, timestamp, sender)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [tenant_id, channel, message, timestamp, sender]
  );
  res.status(201).json({
    status: 'success',
    message: 'Mensagem registrada',
    data: rows[0],
  });
});

// --- Inicializa tabelas e sobe o servidor ---
(async () => {
  try {
    await pool.query(createUsersTable);
    console.log('✅ Tabela "users" pronta');
    await pool.query(createMessagesTable);
    console.log('✅ Tabela "messages" pronta');
  } catch (err) {
    console.error('❌ Erro na migração das tabelas:', err);
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
  });
})();
