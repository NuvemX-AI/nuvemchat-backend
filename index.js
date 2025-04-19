const express = require('express');
const pool = require('./db');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ROTA DE SAÚDE
app.get('/', (req, res) => res.send('API NuvemChat online 🚀'));

// TESTE DE CONEXÃO COM O BANCO
app.get('/testdb', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DEBUG: VER COLUNAS DA TABELA
app.get('/debug/columns', async (req, res) => {
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

// LISTAGEM DE MENSAGENS
app.get('/messages', async (req, res) => {
  const { tenant_id, channel } = req.query;
  let query = 'SELECT * FROM messages';
  const params = [];

  if (tenant_id && channel) {
    query += ' WHERE tenant_id = $1 AND channel = $2';
    params.push(tenant_id, channel);
  } else if (tenant_id) {
    query += ' WHERE tenant_id = $1';
    params.push(tenant_id);
  } else if (channel) {
    query += ' WHERE channel = $1';
    params.push(channel);
  }

  query += ' ORDER BY id DESC LIMIT 100';

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// INSERIR MENSAGEM MANUAL
app.post('/messages', async (req, res) => {
  const { tenant_id, channel, message, timestamp, sender } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO messages (tenant_id, channel, message, timestamp, sender) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [tenant_id, channel, message, timestamp, sender]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ENDPOINT DO WEBHOOK /webhook/message
app.post('/webhook/message', async (req, res) => {
  const { tenant_id, channel, message, timestamp, sender } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO messages (tenant_id, channel, message, timestamp, sender) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [tenant_id, channel, message, timestamp, sender]
    );
    res.status(201).json({
      status: "success",
      message: "Mensagem registrada",
      data: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// INICIAR SERVIDOR
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
