const express = require('express');
const router = express.Router();
const pool = require('./db'); // ajustado para sua estrutura

router.get('/messages', async (req, res) => {
  const { tenant_id, channel } = req.query;

  try {
    let query = 'SELECT * FROM messages WHERE 1=1';
    const values = [];

    if (tenant_id) {
      values.push(tenant_id);
      query += ` AND tenant_id = $${values.length}`;
    }

    if (channel) {
      values.push(channel);
      query += ` AND channel = $${values.length}`;
    }

    query += ' ORDER BY timestamp DESC LIMIT 100';

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar mensagens' });
  }
});

module.exports = router;
