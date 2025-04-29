// routes/instagram.js
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const pool    = require('../db');
require('dotenv').config();

const router = express.Router();

const GRAPH_VERSION      = process.env.FACEBOOK_GRAPH_VERSION || 'v19.0';
const FB_DIALOG_OAUTH    = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const FB_OAUTH_TOKEN_URL = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;

// 1) Webhook GET: verificação do webhook
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

// 2) Webhook POST: recebimento de eventos
router.post('/webhook/instagram', (req, res) => {
  console.log('📬 [Instagram] Evento Webhook:', JSON.stringify(req.body, null, 2));
  // TODO: aqui você pode processar comentários, mensagens, etc.
  return res.sendStatus(200);
});

// 3) Rota para iniciar o fluxo OAuth
//    POST /api/instagram/connect
router.post('/instagram/connect', (req, res) => {
  const clientId    = process.env.INSTAGRAM_CLIENT_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  const tenantId    = req.body?.tenant_id || process.env.TENANT_ID || 'T1';

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      message: 'INSTAGRAM_CLIENT_ID ou INSTAGRAM_REDIRECT_URI não configurados.'
    });
  }

  // adicione pages_messaging aqui:
  const scope = [
    'instagram_basic',
    'pages_show_list',
    'instagram_manage_comments',
    'instagram_manage_messages',
    'pages_messaging'
  ].join(',');

  // state = tenant + nonce para evitar CSRF
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

// 4) Callback do OAuth: troca code por token, busca contas e persiste
//    GET /api/instagram/callback
router.get('/instagram/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) {
      return res.status(400).send('Código de autorização ausente.');
    }

    // extrai tenant do state
    const [tenantId] = (state || '').toString().split(':');

    // troca code ➔ access_token
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

    // busca as páginas do FB que tenham conta IG Business
    const pagesRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`,
      {
        params: {
          fields:       'name,instagram_business_account',
          access_token
        }
      }
    );
    console.log('🔍 [Instagram] resposta de /me/accounts:', JSON.stringify(pagesRes.data, null, 2));

    const page = pagesRes.data.data.find(p => p.instagram_business_account);
    if (!page) {
      return res.status(400).json({
        error: 'Nenhuma Página com conta Instagram profissional vinculada.',
        hint:  'Vincule uma Conta Profissional no Instagram ➔ Configurações → Conta profissional → Centro de Contas.'
      });
    }

    // pega o ID do IG Business
    const igId = page.instagram_business_account.id;

    // busca username e foto do IG
    const igRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/${igId}`,
      {
        params: {
          fields:       'id,username,profile_picture_url',
          access_token
        }
      }
    );
    const { id, username, profile_picture_url } = igRes.data;
    console.log('✅ IG Business ID:', id, '(@', username, ')');

    // persiste no banco (tabela instagram_integrations)
    await pool.query(
      `INSERT INTO instagram_integrations
         (tenant_id, user_id, username, profile_pic, access_token, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id) DO UPDATE SET
         user_id       = EXCLUDED.user_id,
         username      = EXCLUDED.username,
         profile_pic   = EXCLUDED.profile_pic,
         access_token  = EXCLUDED.access_token,
         connected_at  = EXCLUDED.connected_at
      `,
      [
        tenantId,
        id,
        username,
        profile_picture_url,
        access_token,
        new Date()
      ]
    );

    // redireciona pro front-end
    const frontend = process.env.FRONTEND_URL || 'http://localhost:8080';
    return res.redirect(`${frontend}/integrations/instagram/success`);

  } catch (error) {
    console.error('❌ Erro no callback:', error?.response?.data || error.message);
    return res.status(500).send('Erro ao finalizar autenticação Instagram.');
  }
});

module.exports = router;
