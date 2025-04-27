// index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pool = require('./db');
const authRoutes = require('./routes/auth');
const authenticate = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json());

// --- MIGRATION: cria tabela users se não existir ---
const createUsersTable = `
  CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    name           TEXT,
    email          TEXT   NOT NULL UNIQUE,
    password_hash  TEXT   NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

// --- MIGRATION: cria tabela messages se não existir ---
const createMessagesTable = `
  CREATE TABLE IF NOT EXISTS messages (
    id          SERIAL PRIMARY KEY,
    tenant_id   TEXT   NOT NULL,
    channel     TEXT   NOT NULL,
    message     TEXT   NOT NULL,
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT now(),
    sender      TEXT   NOT NULL
  );
`;

// monta as rotas de autenticação (register / login)
app.use('/auth', authRoutes);

// health check
app.get('/', (_req, res) => res.send('API NuvemChat online 🚀'));

// rota protegida de teste de conexão
app.get('/testdb', authenticate, async (_req, res) => {
  const { rows } = await pool.query('SELECT NOW()');
  res.json(rows[0]);
});

// debug colunas
app.get('/debug/columns', authenticate, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_name = 'messages';
  `);
  res.json(rows);
});

// listagem de mensagens
app.get('/messages', authenticate, async (req, res) => {
  const { tenant_id, channel } = req.query;
  let sql = 'SELECT * FROM messages';
  const params = [];

  if (tenant_id && channel) {
    sql += ' WHERE tenant_id = $1 AND channel = $2';
    params.push(tenant_id, channel);
  } else if (tenant_id) {
    sql += ' WHERE tenant_id = $1';
    params.push(tenant_id);
  } else if (channel) {
    sql += ' WHERE channel = $1';
    params.push(channel);
  }

  sql += ' ORDER BY id DESC LIMIT 100';

  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// inserir mensagem manual
app.post('/messages', authenticate, async (req, res) => {
  let { tenant_id, channel, message, timestamp, sender } = req.body;
  message = typeof message === 'string' ? message.replace(/^=/, '') : message;
  sender  = typeof sender  === 'string' ? sender.replace(/^=/, '') : sender;

  const { rows } = await pool.query(
    `INSERT INTO messages
       (tenant_id, channel, message, timestamp, sender)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [tenant_id, channel, message, timestamp, sender]
  );
  res.status(201).json(rows[0]);
});

// webhook público para mensagens do n8n ou outros fluxos
app.post('/webhook/message', async (req, res) => {
  let { tenant_id, channel, message, timestamp, sender } = req.body;
  message = typeof message === 'string' ? message.replace(/^=/, '') : message;
  sender  = typeof sender  === 'string' ? sender.replace(/^=/, '') : sender;

  const { rows } = await pool.query(
    `INSERT INTO messages
       (tenant_id, channel, message, timestamp, sender)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [tenant_id, channel, message, timestamp, sender]
  );
  res.status(201).json({
    status: 'success',
    message: 'Mensagem registrada',
    data: rows[0],
  });
});

// ✅ Webhook do Instagram Business: verificação (GET) + recebimento de mensagens (POST)
const VERIFY_TOKEN = 'nuvemchatcrm123'; // o mesmo que você cadastrou no Facebook Developers!

// GET - Verificação do webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ WEBHOOK VERIFICADO COM SUCESSO');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Falha na verificação do webhook');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// POST - Recebimento de mensagens do Instagram
app.post('/webhook', (req, res) => {
  console.log('📩 Evento recebido do Instagram:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// --- inicia servidor
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
