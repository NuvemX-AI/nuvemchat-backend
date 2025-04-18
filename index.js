const express = require('express');
const pool = require('./db'); // Importa sua conexão do db.js

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('API NuvemChat online 🚀'));

// Teste de conexão com o banco
app.get('/testdb', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT NOW()');
    res.json(resultado.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// NOVA ROTA: Listar mensagens do chat
app.get('/messages', async (req, res) => {
  try {
    const resultado = await pool.query('SELECT * FROM messages ORDER BY id DESC LIMIT 100');
    res.json(resultado.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
