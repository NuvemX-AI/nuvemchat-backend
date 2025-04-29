// routes/instagram.js
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
require('dotenv').config();

const router = express.Router();

const GRAPH_VERSION      = process.env.FACEBOOK_GRAPH_VERSION || 'v19.0';
const FB_DIALOG_OAUTH    = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const FB_OAUTH_TOKEN_URL = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;

// 1) Webhook GET: verificação
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

// 2) Webhook POST: eventos
router.post('/webhook/instagram', (req, res) => {
  console.log('📬 [Instagram] Evento Webhook:', JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

// 3) Conectar via OAuth
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

  // usa só crypto.randomUUID()
  const state = `${tenantId}:${crypto.randomUUID()}`;

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope,
    response_type: 'code',
    state
  });

  const authUrl = `${FB_DIALOG_OAUTH}?${params.toString()}`;
  console.log('🔗 [Instagram] authUrl gerado:', authUrl);

  return res.json({ url: authUrl });
});

// 4) Callback do OAuth
router.get('/instagram/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Código de autorização ausente.');

    const [tenantId] = (state || '').toString().split(':');

    // troca code → access_token
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

    // busca páginas com IG Business
    const pagesRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`,
      {
        params: {
          fields: 'name,instagram_business_account',
          access_token
        }
      }
    );

    const page = pagesRes.data.data.find(p => p.instagram_business_account);
    if (!page) {
      return res.status(400).json({
        error: 'Nenhuma Página com conta Instagram profissional vinculada.',
        hint:  'Vincule a Página nas configurações de Conta Profissional.'
      });
    }

    const igId = page.instagram_business_account.id;

    // busca dados da conta IG
    const igRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/${igId}`,
      {
        params: {
          fields: 'id,username,profile_picture_url',
          access_token
        }
      }
    );

    const { id, username, profile_picture_url } = igRes.data;
    console.log('✅ IG Business ID:', id, '(@', username, ')');

    // persiste no banco (use seu pool ou ORM)
    await req.db('instagram_integrations')
      .insert({
        tenant_id:   tenantId,
        user_id:     id,
        username,
        profile_pic: profile_picture_url,
        access_token,
        connected_at: new Date()
      })
      .onConflict('tenant_id')
      .merge();

    // redireciona pro frontend
    const frontend = process.env.FRONTEND_URL || 'http://localhost:8080';
    return res.redirect(`${frontend}/integrations/instagram/success`);

  } catch (err) {
    console.error('❌ Erro no callback:', err?.response?.data || err.message);
    return res.status(500).send('Erro ao finalizar autenticação Instagram.');
  }
});

module.exports = router;

