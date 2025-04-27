// routes/instagram.js
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch'); // ✅ garantir o fetch no Node.js
require('dotenv').config();

// =====================================
// POST /api/instagram/connect
// Gera a URL de conexão OAuth do Instagram
// =====================================
router.post('/instagram/connect', async (_req, res) => {
  try {
    const clientId = process.env.INSTAGRAM_CLIENT_ID;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      return res.status(500).json({ message: 'Variáveis de ambiente do Instagram faltando.' });
    }

    const scope = 'user_profile,user_media';
    const authUrl = `https://api.instagram.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=code`;

    return res.status(200).json({ url: authUrl });
  } catch (error) {
    console.error('❌ Erro ao gerar URL de autorização do Instagram:', error.message);
    return res.status(500).json({ message: 'Erro ao gerar URL de conexão com o Instagram.' });
  }
});

// =====================================
// GET /api/instagram/callback
// Recebe o code do Instagram e troca pelo access_token
// =====================================
router.get('/instagram/callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send('Código de autorização não encontrado.');
    }

    const clientId = process.env.INSTAGRAM_CLIENT_ID;
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: code,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error_type) {
      console.error('❌ Erro no token:', tokenData.error_message);
      throw new Error(tokenData.error_message || 'Erro ao trocar o code pelo token.');
    }

    const { access_token, user_id } = tokenData;

    console.log('✅ Access Token recebido:', access_token);
    console.log('✅ User ID recebido:', user_id);

    // (Opcional) Aqui você poderia salvar o access_token e o user_id no banco para uso futuro

    // Redireciona para o painel com sucesso
    return res.redirect('http://localhost:8080/integracoes?connected=instagram');

  } catch (error) {
    console.error('❌ Erro no callback do Instagram:', error.message);
    return res.status(500).send('Erro no processo de autenticação com o Instagram.');
  }
});

module.exports = router;
