// index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
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
    id                      SERIAL PRIMARY KEY,
    tenant_id               TEXT   NOT NULL,
    channel                 TEXT   NOT NULL,
    message                 TEXT   NOT NULL,
    timestamp               TIMESTAMPTZ NOT NULL DEFAULT now(),
    sender                  TEXT   NOT NULL,
    sender_username         TEXT,
    sender_profile_picture  TEXT
  );
`;

// monta as rotas de autenticação
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

// webhook público do N8N (ou outros fluxos externos)
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

// webhook do Instagram: verificação do Facebook
app.get('/api/webhook/instagram', (req, res) => {
  const VERIFY_TOKEN = 'nuvemchatcrm123';

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verificado com sucesso.');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// webhook do Instagram: recebimento de mensagens + username + foto
app.post('/api/webhook/instagram', async (req, res) => {
  try {
    const body = req.body;

    console.log('📩 Evento recebido:', JSON.stringify(body, null, 2));

    if (body.object === 'instagram') {
      for (const entry of body.entry) {
        for (const messagingEvent of entry.messaging) {
          const senderId = messagingEvent.sender.id;
          const messageText = messagingEvent.message?.text || '';
          const timestamp = new Date(messagingEvent.timestamp).toISOString();

          // Access Token fixo por enquanto
          const accessToken = 'SEU_ACCESS_TOKEN_FIXO_AQUI'; // ⚠️ depois vamos tornar dinâmico por cliente

          // Buscar dados do remetente
          const userDetailsUrl = `https://graph.facebook.com/v22.0/${senderId}?fields=id,username,profile_picture_url&access_token=${accessToken}`;
          const { data: userDetails } = await axios.get(userDetailsUrl);

          const username = userDetails.username || 'desconhecido';
          const profilePicture = userDetails.profile_picture_url || '';

          // Gravar no banco
          await pool.query(
            `INSERT INTO messages
              (tenant_id, channel, message, timestamp, sender, sender_username, sender_profile_picture)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              'SEU_TENANT_ID_FIXO', // ⚠️ depois vamos tornar dinâmico pelo cliente logado
              'instagram',
              messageText,
              timestamp,
              senderId,
              username,
              profilePicture,
            ]
          );

          console.log(`✅ Mensagem de @${username} gravada.`);
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// inicia servidor
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
