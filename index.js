const express = require('express');
const pool = require('./db'); // Importa sua conexão do db.js

const app = express();
app.use(express.json());

// Saúde/check API
app.get('/', (req, res) => res.send('API NuvemChat online 🚀'));

// Testa conexão com banco
app.get('/testdb', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT NOW()');
    res.json(resultado.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * ENDPOINT DE DEBUG Para ver as colunas reais da tabela messages
 * Acesse em: /debug/columns
 */
app.get('/debug/columns', async (req, res) => {
  try {
    const cols = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns
      WHERE table_name = 'messages'
    `);
    res.json(cols.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /messages
 * Filtros opcionais por query string: ?tenant_id=xxx&channel=yyy
 */
app.get('/messages', async (req, res) => {
  try {
    const { tenant_id, channel } = req.query;
    let query = 'SELECT * FROM messages';
    let params = [];

    if (tenant_id && channel) {
      query += ' WHERE tenant_id = $1 AND channel = $2';
      params = [tenant_id, channel];
    } else if (tenant_id) {
      query += ' WHERE tenant_id = $1';
      params = [tenant_id];
    } else if (channel) {
      query += ' WHERE channel = $1';
      params = [channel];
    }
    query += ' ORDER BY id DESC LIMIT 100';

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /messages
 * Inserção manual (útil para testes, além do webhook)
 */
app.post('/messages', async (req, res) => {
  try {
    const { tenant_id, channel, message, timestamp, sender } = req.body;
    const resultado = await pool.query(
      'INSERT INTO messages (tenant_id, channel, message, timestamp, sender) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [tenant_id, channel, message, timestamp, sender]
    );
    res.status(201).json(resultado.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /webhook/message
 * Payload enviado pelo N8N ou outros canais.
 */
app.post('/webhook/message', async (req, res) => {
  try {
    const { tenant_id, channel, message, timestamp, sender } = req.body;
    const resultado = await pool.query(
      'INSERT INTO messages (tenant_id, channel, message, timestamp, sender) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [tenant_id, channel, message, timestamp, sender]
    );
    res.status(201).json({ status: "success", message: "Mensagem registrada", data: resultado.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
