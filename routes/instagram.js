// routes/instagram.js

const express = require('express');
const router = express.Router();
require('dotenv').config();

// =================================================================
// 1) Webhook do Instagram: verificação e recebimento de eventos
// =================================================================

// GET  /api/webhook/instagram
// Verificação do Meta: devolve hub.challenge se o token bater
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

// POST /api/webhook/instagram
// Recebe eventos de mensagens, comentários, etc.
router.post('/webhook/instagram', (req, res) => {
  console.log('📬 Evento de Webhook recebido:', JSON.stringify(req.body, null, 2));
  // Aqui você pode iterar por req.body.entry e salvar no banco ou emitir eventos internos
  return res.sendStatus(200);
});

// =================================================================
// 2) OAuth Instagram: geração de URL e callback de troca de code
// =================================================================

// POST /api/instagram/connect
// Gera a URL de autorização do Instagram
router.post('/instagram/connect', async (_req, res) => {
  try {
    const clientId    = process.env.INSTAGRAM_CLIENT_ID;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return res
        .status(500)
        .json({ message: 'Faltando variáveis de ambiente: INSTAGRAM_CLIENT_ID ou INSTAGRAM_REDIRECT_URI.' });
    }

    const scope = 'user_profile,user_media';
    const authUrl =
      `https://api.instagram.com/oauth/authorize` +
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

// GET /api/instagram/callback
// Recebe o code e troca pelo access_token
router.get('/instagram/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send('Código de autorização não fornecido.');
    }

    const clientId     = process.env.INSTAGRAM_CLIENT_ID;
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
    const redirectUri  = process.env.INSTAGRAM_REDIRECT_URI;

    // Usa fetch nativo do Node.js v18+
    const response = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'authorization_code',
        redirect_uri:  redirectUri,
        code:          code.toString(),
      }),
    });

    const data = await response.json();
    if (data.error_type) {
      console.error('❌ Erro ao trocar code por token:', data.error_message);
      return res.status(500).send(data.error_message || 'Erro na troca de token.');
    }

    const { access_token, user_id } = data;
    console.log('✅ Access Token recebido:', access_token);
    console.log('✅ User ID recebido:', user_id);

    // TODO: Salvar access_token e user_id no banco, associado ao tenant/usuário

    // Redireciona para o front-end com flag de sucesso
    const frontend = process.env.FRONTEND_URL || 'http://localhost:8080';
    return res.redirect(`${frontend}/integracoes?connected=instagram`);
  } catch (error) {
    console.error('❌ Erro no callback do Instagram:', error);
    return res.status(500).send('Erro no processo de autenticação do Instagram.');
  }
});

module.exports = router;
