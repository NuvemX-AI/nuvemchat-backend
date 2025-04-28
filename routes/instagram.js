// routes/instagram.js

const express = require('express');
const router  = express.Router();
require('dotenv').config();

// =================================================================
// 1) Webhook do Instagram: verificação e recebimento de eventos
// =================================================================

router.get('/webhook/instagram', (req, res) => {
  console.log('🔔 [Instagram] GET /webhook/instagram', req.query);
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  }

  console.warn('❌ WEBHOOK_VERIFICATION_FAILED');
  return res.sendStatus(403);
});

router.post('/webhook/instagram', (req, res) => {
  console.log('📬 Evento de Webhook recebido:', JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

// =================================================================
// 2) OAuth Instagram Graph API: geração de URL e callback de troca de code
// =================================================================

router.post('/instagram/connect', async (_req, res) => {
  try {
    const clientId    = process.env.INSTAGRAM_CLIENT_ID;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return res
        .status(500)
        .json({ message: 'Faltando INSTAGRAM_CLIENT_ID ou INSTAGRAM_REDIRECT_URI.' });
    }

    const version = 'v16.0';
    const scope   = [
      'instagram_basic',
      'instagram_manage_comments',
      'instagram_manage_messages',
      'pages_show_list'
    ].join(',');

    const authUrl =
      `https://www.facebook.com/${version}/dialog/oauth` +
      `?client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${scope}` +
      `&response_type=code`;

    return res.status(200).json({ url: authUrl });
  } catch (error) {
    console.error('❌ Erro ao gerar URL de autorização:', error);
    return res
      .status(500)
      .json({ message: 'Erro interno ao gerar URL de autorização do Instagram.' });
  }
});

router.get('/instagram/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send('Código de autorização não fornecido.');
    }

    const clientId     = process.env.INSTAGRAM_CLIENT_ID;
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
    const redirectUri  = process.env.INSTAGRAM_REDIRECT_URI;
    const version      = 'v16.0';

    // troca code por access_token via Graph API
    const tokenRes = await fetch(
      `https://graph.facebook.com/${version}/oauth/access_token` +
      `?client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&client_secret=${clientSecret}` +
      `&code=${code}`
    );
    const data = await tokenRes.json();
    if (data.error) {
      console.error('❌ Erro ao trocar code por token:', data.error);
      return res.status(500).send(data.error.message || 'Erro na troca de código.');
    }

    const { access_token, user_id } = data;
    console.log('✅ Access Token recebido:', access_token);
    console.log('✅ User ID recebido:', user_id);

    // TODO: salvar no banco...

    const frontend = process.env.FRONTEND_URL || 'http://localhost:8080';
    return res.redirect(`${frontend}/integracoes?connected=instagram`);
  } catch (error) {
    console.error('❌ Erro no callback do Instagram:', error);
    return res.status(500).send('Erro no processo de autenticação do Instagram.');
  }
});

module.exports = router;
