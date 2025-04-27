// routes/instagram.js
const express = require('express');
const router = express.Router();
require('dotenv').config();

// =====================================
// ROTA: POST /api/instagram/connect
// Gera a URL para o usuário conectar o Instagram
// =====================================
router.post('/connect', async (req, res) => {
  try {
    const clientId = process.env.INSTAGRAM_CLIENT_ID;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    const instagramAuthUrl = `https://api.instagram.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=user_profile,user_media&response_type=code`;

    return res.status(200).json({ url: instagramAuthUrl });
  } catch (error) {
    console.error('Erro ao gerar URL de autorização do Instagram:', error.message);
    return res.status(500).json({ message: 'Erro ao conectar com Instagram' });
  }
});

// =====================================
// ROTA: GET /api/instagram/callback
// Recebe o "code" do Instagram e troca pelo access_token
// =====================================
router.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ message: 'Código de autorização não encontrado.' });
    }

    const clientId = process.env.INSTAGRAM_CLIENT_ID;
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    // Trocar o code por access_token
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
      throw new Error(tokenData.error_message || 'Erro ao trocar code por token.');
    }

    const { access_token, user_id } = tokenData;

    console.log('✅ Access Token:', access_token);
    console.log('✅ User ID:', user_id);

    // (Opcional) Aqui você poderia salvar o access_token e user_id no banco para o usuário logado

    // Redirecionar o usuário de volta para o painel
    return res.redirect('http://localhost:8080/integrations?connected=instagram');

  } catch (error) {
    console.error('❌ Erro no callback Instagram:', error.message);
    return res.status(500).send('Erro ao conectar com o Instagram.');
  }
});

module.exports = router;
