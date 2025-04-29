// routes/instagram.js
// ------------------------------------------------------------
// Integração Instagram Business (Graph API) via Facebook Login
// ------------------------------------------------------------
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
require('dotenv').config();

const router = express.Router();

//--------------------------------------------------------------------
// Helpers
//--------------------------------------------------------------------
const GRAPH_VERSION      = process.env.FACEBOOK_GRAPH_VERSION || 'v19.0';
const FB_DIALOG_OAUTH    = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const FB_OAUTH_TOKEN_URL = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;

//--------------------------------------------------------------------
// 1) Webhook
//--------------------------------------------------------------------
router.get('/webhook/instagram', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/webhook/instagram', (req, res) => {
  console.log('📬 Webhook IG:', JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

//--------------------------------------------------------------------
// 2) OAuth  – POST /api/instagram/connect
//--------------------------------------------------------------------
router.post('/instagram/connect', (req, res) => {
  const clientId    = process.env.INSTAGRAM_CLIENT_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  const tenantId    = req.body?.tenant_id || process.env.TENANT_ID || 'T1';

  const scope = [
    'instagram_basic',
    'pages_show_list',
    'instagram_manage_comments',
    'instagram_manage_messages'
  ].join(',');

  const state = `${tenantId}:${crypto.randomUUID()}`;

  const authUrl =
    `${FB_DIALOG_OAUTH}?` +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      response_type: 'code',
      state
    }).toString();

  return res.json({ url: authUrl });
});

//--------------------------------------------------------------------
// 3) Callback  – GET /api/instagram/callback
//--------------------------------------------------------------------
router.get('/instagram/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Código de autorização ausente.');

    const [tenantId] = (state || '').toString().split(':');

    // 3.1 trocar code -> access_token
    const tokenRes = await axios.get(FB_OAUTH_TOKEN_URL, {
      params: {
        client_id:     process.env.INSTAGRAM_CLIENT_ID,
        client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
        redirect_uri:  process.env.INSTAGRAM_REDIRECT_URI,
        code
      }
    });
    const { access_token } = tokenRes.data;

    // 3.2 listar páginas que tenham conta IG
    const pagesRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`,
      { params: { fields: 'name,instagram_business_account', access_token } }
    );
    const page = pagesRes.data.data.find(p => p.instagram_business_account);
    if (!page) {
      return res.status(400).json({
        error: 'Nenhuma Página com conta Instagram profissional vinculada.',
        hint:  'Abra o app Instagram → Configurações → Conta profissional → Centro de Contas e vincule a Página.'
      });
    }
    const igId = page.instagram_business_account.id;

    // 3.3 pegar username + foto
    const igRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/${igId}`,
      { params: { fields: 'id,username,profile_picture_url', access_token } }
    );
    const { id, username, profile_picture_url } = igRes.data;

    // 3.4 persistir (troque req.db pelo seu helper de banco)
    await req.db('instagram_integrations')
      .insert({
        tenant_id:    tenantId,
        user_id:      id,
        username,
        profile_pic:  profile_picture_url,
        access_token,
        connected_at: new Date()
      })
      .onConflict('tenant_id')
      .merge();

    // 3.5 redireciona p/ front
    const frontend = process.env.FRONTEND_URL || 'http://localhost:8080';
    return res.redirect(`${frontend}/integrations/instagram/success`);
  } catch (err) {
    console.error('❌ Callback IG erro:', err?.response?.data || err.message);
    return res.status(500).send('Erro ao finalizar autenticação Instagram.');
  }
});

module.exports = router;
