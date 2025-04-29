// routes/instagram.js
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const router = express.Router();

/* Helpers */
const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v19.0';
const FB_DIALOG_OAUTH = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const FB_OAUTH_TOKEN_URL = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`;

/* Webhook (GET para verificação) */
router.get('/webhook/instagram', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': ch } = req.query;

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(ch);
  } else {
    return res.sendStatus(403);
  }
});

/* Webhook (POST para eventos) */
router.post('/webhook/instagram', (req, res) => {
  console.log('📬 Webhook IG recebido:', JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

/* Geração da URL de login (step 1) */
router.post('/instagram/connect', (req, res) => {
  const scope = [
    'instagram_basic',
    'pages_show_list',
    'instagram_manage_comments',
    'instagram_manage_messages'
  ].join(',');

  const tenantId = req.body?.tenant_id || process.env.TENANT_ID || 'T1';
  const state = `${tenantId}:${crypto.randomUUID()}`;

  const authUrl = `${FB_DIALOG_OAUTH}?` + new URLSearchParams({
    client_id: process.env.INSTAGRAM_CLIENT_ID,
    redirect_uri: process.env.INSTAGRAM_REDIRECT_URI,
    scope,
    response_type: 'code',
    state
  }).toString();

  return res.json({ url: authUrl });
});

/* Callback (step 2) */
router.get('/instagram/callback', async (req, res) => {
  console.log('⚡️ CALLBACK HIT', new Date().toISOString(), req.query);

  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Código de autorização ausente.');

    const [tenantId] = (state || '').toString().split(':');

    // Step 3.1: trocar code por token
    const { data: tok } = await axios.get(FB_OAUTH_TOKEN_URL, {
      params: {
        client_id: process.env.INSTAGRAM_CLIENT_ID,
        client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
        redirect_uri: process.env.INSTAGRAM_REDIRECT_URI,
        code
      }
    });

    const access_token = tok.access_token;

    // Step 3.2: buscar páginas com conta IG vinculada
    const { data: pages } = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts`,
      {
        params: {
          fields: 'id,name,instagram_business_account',
          access_token
        }
      }
    );

    console.log('🔎 pages:', JSON.stringify(pages, null, 2));

    const page = pages.data.find(p => p.instagram_business_account);
    if (!page) {
      const fe = process.env.FRONTEND_URL || 'http://localhost:8080';
      return res.redirect(
        `${fe}/integracoes?igError=` +
        encodeURIComponent('Vincule sua conta Instagram profissional à Página e tente novamente.')
      );
    }

    const igId = page.instagram_business_account.id;

    // Step 3.3: buscar dados da conta IG
    const { data: ig } = await axios.get(
      `https://graph.facebook.com/${GRAPH_VERSION}/${igId}`,
      {
        params: {
          fields: 'id,username,profile_picture_url',
          access_token
        }
      }
    );

    console.log(`✅ Conta IG vinculada: @${ig.username} (id: ${ig.id})`);

    // Step 3.4: salvar no banco (se disponível)
    if (req.db) {
      await req.db('instagram_integrations')
        .insert({
          tenant_id: tenantId,
          user_id: ig.id,
          username: ig.username,
          profile_pic: ig.profile_picture_url,
          access_token,
          connected_at: new Date()
        })
        .onConflict('tenant_id').merge();
    } else {
      console.warn('⚠️  req.db não disponível – dados não foram salvos');
    }

    // Step 3.5: redirecionar para sucesso
    const frontend = process.env.FRONTEND_URL || 'http://localhost:8080';
    return res.redirect(`${frontend}/integracoes/instagram/success`);

  } catch (err) {
    console.error('❌ Erro na callback do Instagram:', err?.response?.data || err.message);
    return res.status(500).send('Erro ao finalizar autenticação Instagram.');
  }
});

module.exports = router;
