const express = require('express');
const pool = require('./db');
const cors = require('cors');

const app = express();
app.use(cors()); // permite chamadas do frontend
app.use(express.json());

// --- HEALTH CHECK ---
app.get('/', (req, res) => res.send('API NuvemChat online 🚀'));

// --- TESTA CONEXÃO COM O BANCO ---
app.get('/testdb', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DEBUG: VER COLUNAS DA TABELA MESSAGES ---
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

// --- GET /messages ---
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

// --- POST /messages (inserção manual ou teste) ---
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

// --- POST /webhook/message (via N8N ou canais externos) ---
app.post('/webhook/message', async (req, res) => {
  const { tenant_id, channel, message, timestamp, sender } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO messages (tenant_id, channel, message, timestamp, sender) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [tenant_id, channel, message, timestamp, sender]
    );
    res.status(201).json({
      status: '
