// routes/instagram.js
// ------------------------------------------------------------
// Integração Instagram Business (Graph API) via Facebook Login
// ------------------------------------------------------------
// • Webhook de verificação/recebimento de eventos
// • Geração da URL de OAuth (Facebook Login ⇢ Instagram)
// • Callback: troca code ➜ access_token, captura user_id
// ------------------------------------------------------------
// OBS:
// 1) Requer as variáveis no .env:
//    INSTAGRAM_CLIENT_ID=719915063935873
//    INSTAGRAM_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//    INSTAGRAM_REDIRECT_URI=https://nuvemchat-backend-production.up.railway.app/api/instagram/callback
//    FRONTEND_URL=http://localhost:8080
//    FACEBOOK_GRAPH_VERSION=v19.0          # opcional (default)
// 2) Endpoint antigo api.instagram.com/oauth/authorize (Basic Display)
//    foi descontinuado em 2024-12. Este arquivo já usa o fluxo oficial
//    Facebook Login / Business Login.

const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
require('dotenv').config();

const router  = express.Router();

//--------------------------------------------------------------------
// Helpers
//--------------------------------------------------------------------
const GRAPH_VERSION      = process.env.FACEBOOK_GRAPH_VERSION || 'v19.0';
const FB_DIALOG_OAUTH    = https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth;
const FB_OAUTH_TOKEN_URL = https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token;

//--------------------------------------------------------------------
// 1) Webhook do Instagram: verificação e recebimento de eventos
//--------------------------------------------------------------------

// GET  /api/webhook/instagram
router.get('/webhook/instagram', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔔 [Instagram] Verificação de Webhook', req.query);

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ WEBHOOK_VERIFIED');
    return res.status(200).send(challenge);
  }
  console.warn('❌ WEBHOOK_VERIFICATION_FAILED');
  return res.sendStatus(403);
});

// POST /api/webhook/instagram
router.post('/webhook/instagram', (req, res) => {
  console.log('📬 [Instagram] Evento Webhook:', JSON.stringify(req.body, null, 2));
  // TODO: processar eventos de mensagens/comentários aqui
  return res.sendStatus(200);
});

//--------------------------------------------------------------------
// 2) OAuth Instagram (Facebook Login → Graph API)
//--------------------------------------------------------------------

// POST /api/instagram/connect
// body opcional: { tenant_id: "T1" }
router.post('/instagram/connect', (req, res) => {
  const clientId    = process.env.INSTAGRAM_CLIENT_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  const tenantId    = req.body?.tenant_id || process.env.TENANT_ID || 'T1';

  if (!clientId || !redirectUri) {
    return res.status(500).json({ message: 'INSTAGRAM_CLIENT_ID ou INSTAGRAM_REDIRECT_URI não configurados.' });
  }

  const scope = [
    'instagram_basic',
    'pages_show_list',
    'instagram_manage_comments',
    'instagram_manage_messages'
  ].join(',');

  // State: tenant + nonce para evitar CSRF
  const state = ${tenantId}:${crypto.randomUUID()};

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope,
    response_type: 'code',
    state
  });

  const authUrl = ${FB_DIALOG_OAUTH}?${params.toString()};
  console.log('🔗 [Instagram] authUrl gerado:', authUrl);

  return res.json({ url: authUrl });
});

// GET /api/instagram/callback
router.get('/instagram/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Código de autorização ausente.');

    const [tenantId] = (state || '').toString().split(':');

    // Troca code → access_token (short‑lived)
    const tokenRes = await axios.get(FB_OAUTH_TOKEN_URL, {
      params: {
        client_id:     process.env.INSTAGRAM_CLIENT_ID,
        client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
        redirect_uri:  process.env.INSTAGRAM_REDIRECT_URI,
        code
      }
    });

    const { access_token } = tokenRes.data;
    console.log('✅ Access Token:', access_token);

    // Descobrir user_id (passo mínimo)
    const meRes = await axios.get(https://graph.facebook.com/${GRAPH_VERSION}/me, {
      params: { fields: 'id', access_token }
    });
    const { id: fb_user_id } = meRes.data;
    console.log('✅ Facebook User ID:', fb_user_id);

    // ------------------------------------------------------------
    // Opcional: descobrir a conta Instagram Business vinculada
    // ------------------------------------------------------------
    // const pages = await axios.get(https://graph.facebook.com/${GRAPH_VERSION}/me/accounts, {
    //   params: { fields: 'instagram_business_account', access_token }
    // });
    // const igAccount = pages.data.data.find(p => p.instagram_business_account);
    // const user_id  = igAccount?.instagram_business_account?.id;
    // console.log('✅ IG Business ID:', user_id);
    // ------------------------------------------------------------

    const user_id = fb_user_id; // temporário: use FB user id se não precisar de IG ID

    // TODO: persistir em "instagram_integrations" (tenant_id, access_token, user_id) em "instagram_integrations" (tenant_id, access_token, user_id, username)

    // Redirecionar para o front-end
    const frontend = process.env.FRONTEND_URL || 'http://localhost:8080';
    return res.redirect(${frontend}/integrations/instagram/success);

  } catch (error) {
    console.error('❌ Erro no callback:', error?.response?.data || error.message);
    return res.status(500).send('Erro ao finalizar autenticação Instagram.');
  }
});

module.exports = router;
