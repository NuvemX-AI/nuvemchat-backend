// index.js
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const pool      = require('./db');
const authRoutes    = require('./routes/auth');
const authenticate  = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json());

// --- MIGRATION: cria tabela users se não existir ---
const createUsersTable = `
  CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    email          TEXT   NOT NULL UNIQUE,
    password_hash  TEXT   NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

// rotas de auth (register/login)
app.use('/auth', authRoutes);

// health check
app.get('/', (_req, res) => res.send('API NuvemChat online 🚀'));

// rota protegida de teste DB
app.get('/testdb', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// debug colunas
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

  try {
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// inserir mensagem manual (trim “=”)
app.post('/messages', authenticate, async (req, res) => {
  let { tenant_id, channel, message, timestamp, sender } = req.body;

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

// webhook público (trim “=”)
app.post('/webhook/message', async (req, res) => {
  let { tenant_id, channel, message, timestamp, sender } = req.body;

  message = (typeof message === 'string' ? message.replace(/^=/, '') : message);
  sender  = (typeof sender  === 'string' ? sender.replace(/^=/,  '') : sender);

  try {
    const result = await pool.query(
      'INSERT INTO messages (tenant_id, channel, message, timestamp, sender) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [tenant_id, channel, message, timestamp, sender]
    );
    res.status(201).json({
      status: 'success',
      message: 'Mensagem registrada',
      data: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// migração + start do servidor
(async () => {
  try {
    await pool.query(createUsersTable);
    console.log('✅ Tabela "users" pronta');
  } catch (err) {
    console.error('❌ Erro criando tabela users:', err);
  }

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`🚀 Servidor rodando na porta ${port}`);
  });
})();
