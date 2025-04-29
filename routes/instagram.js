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

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) Webhook POST: recebimento de eventos
router.post('/webhook/instagram', (_req, res) => {
  // console.log('📬 Evento Webhook:', JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

// 3) Rota para iniciar OAuth
router.post('/instagram/connect', (req, res) => {
  const clientId    = process.env.INSTAGRAM_CLIENT_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  const tenantId    = req.body?.tenant_id || process.env.TENANT_ID || 'T1';

  if (!clientId || !redirectUri) {
    return res.status(500).json({ message: 'Faltando INSTAGRAM_CLIENT_ID ou INSTAGRAM_REDIRECT_URI' });
  }

  // incluímos pages_messaging aqui!
  const scope = [
    'instagram_basic',
    'pages_show_list',
    'instagram_manage_comments',
    'instagram_manage_messages',
    'pages_messaging'
  ].join(',');

  const state  = `${tenantId}:${crypto.randomUUID()}`;
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope,
    response_type: 'code',
    state
  });

  const authUrl = `${FB_DIALOG_OAUTH}?${params.toString()}`;
  return res.json({ url: authUrl });
});

// 4) Callback OAuth
router.get('/instagram/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Código de autorização ausente.');

    const [tenantId] = (state || '').toString().split(':');

    // troca code ➔ token
    const tokenRes = await axios.get(FB_OAUTH_TOKEN_URL, {
      params: {
        client_id:     process.env.INSTAGRAM_CLIENT_ID,
        client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
        redirect_uri:  process.env.INSTAGRAM_REDIRECT_URI,
        code
      }
    });
    const userAccessToken = tokenRes.data.access_token;

    // pega lista de Páginas com IG Business
    const pagesRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`,
      { params: { fields: 'name,instagram_business_account', access_token: userAccessToken } }
    );
    const page = pagesRes.data.data.find(p => p.instagram_business_account);
    if (!page) {
      return res.status(400).json({
        error: 'Nenhuma Página com Conta Profissional vinculada.',
        hint:  'Vincule sua Conta Profissional no Instagram → Configurações → Conta profissional → Centro de Contas.'
      });
    }

    // pega o Page Access Token
    const pageTokenRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/${page.id}`,
      { params: { fields: 'access_token', access_token: userAccessToken } }
    );
    const pageAccessToken = pageTokenRes.data.access_token;

    // ID do IG Business
    const igId = page.instagram_business_account.id;

    // subscribe ao webhook de mensagens no IG Business
    await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${igId}/subscribed_apps`,
      null,
      {
        params: {
          subscribed_fields: 'messages,messaging_postbacks,messaging_optins',
          access_token: pageAccessToken
        }
      }
    );

    // opcional: buscar info do IG (username, foto)
    const igRes = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/${igId}`,
      {
        params: {
          fields:       'id,username,profile_picture_url',
          access_token: userAccessToken
        }
      }
    );
    const { id, username, profile_picture_url } = igRes.data;

    // persiste em instagram_integrations
    await pool.query(
      `INSERT INTO instagram_integrations
         (tenant_id, user_id, username, profile_pic, access_token, connected_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id) DO UPDATE SET
         user_id      = EXCLUDED.user_id,
         username     = EXCLUDED.username,
         profile_pic  = EXCLUDED.profile_pic,
         access_token = EXCLUDED.access_token,
         connected_at = EXCLUDED.connected_at
      `,
      [
        tenantId,
        id,
        username,
        profile_picture_url,
        userAccessToken,
        new Date()
      ]
    );

    // redireciona pro front
    const frontend = process.env.FRONTEND_URL || 'http://localhost:8080';
    return res.redirect(`${frontend}/integrations/instagram/success`);

  } catch (err) {
    console.error('❌ Erro no callback:', err.response?.data || err.message);
    return res.status(500).send('Erro ao finalizar autenticação Instagram.');
  }
});

module.exports = router;
