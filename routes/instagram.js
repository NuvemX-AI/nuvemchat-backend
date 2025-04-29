// routes/instagram.js

const express = require('express');
const router  = express.Router();
require('dotenv').config();

// =================================================================
// 1) Webhook do Instagram: verificação e recebimento de eventos
// =================================================================

// GET /api/webhook/instagram
// Valida o token de verificação e retorna o hub.challenge
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
  // TODO: processe req.body.entry e salve no banco…
  return res.sendStatus(200);
});

// =================================================================
// 2) OAuth Instagram Basic Display: geração de URL e callback de troca de code
// =================================================================

// POST /api/instagram/connect
// Gera a URL de autorização no Instagram Basic Display
router.post('/instagram/connect', (_req, res) => {
  const clientId    = process.env.INSTAGRAM_CLIENT_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      message: 'Faltando INSTAGRAM_CLIENT_ID ou INSTAGRAM_REDIRECT_URI no .env'
    });
  }

  const scope = 'user_profile,user_media';
  const authUrl =
    `https://api.instagram.com/oauth/authorize` +
    `?client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scope}` +
    `&response_type=code`;

  return res.status(200).json({ url: authUrl });
});

// GET /api/instagram/callback
// Recebe o code e troca por access_token no Basic Display
router.get('/instagram/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send('Código de autorização não fornecido.');
    }

    const clientId     = process.env.INSTAGRAM_CLIENT_ID;
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;
    const redirectUri  = process.env.INSTAGRAM_REDIRECT_URI;

    // Troca code por access_token
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
      console.error('❌ Erro no Basic Display token:', data.error_message);
      return res.status(500).send(data.error_message || 'Erro na troca de token.');
    }

    const { access_token, user_id } = data;
    console.log('✅ Access Token (Basic Display):', access_token);
    console.log('✅ User ID (Basic Display):', user_id);

    // TODO: salvar access_token e user_id no banco, se quiser

    // Redireciona de volta pro front
    const frontend = process.env.FRONTEND_URL || 'http://localhost:8080';
    return res.redirect(`${frontend}/integracoes?connected=instagram`);

  } catch (err) {
    console.error('❌ Erro no callback Basic Display:', err);
    return res
      .status(500)
      .send('Erro no processo de autenticação Instagram Basic Display.');
  }
});

module.exports = router;
