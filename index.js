import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import { clerkMiddleware, requireAuth } from '@clerk/express';
import OpenAI from 'openai';
import cors from 'cors';
import { htmlToText } from 'html-to-text';
import { DeliveryMethod, LATEST_API_VERSION } from '@shopify/shopify-api';
import multer from 'multer';
import fs from 'fs';
import pdfExtract from 'pdf-extraction';
import { convert } from 'html-to-text';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { supabase } from './lib/supabaseClient.js';
import { redis } from './lib/redisClient.js';
import { getShopifyInstance } from './lib/shopifyInitializer.js';
import { getEncryptionKey, encrypt, decrypt, getShopifySession } from './lib/utils.js'; 
import chatRouter from './lib/chatHandler.js';
import { handleEvolutionWebhook } from './lib/whatsappWebhookHandler.js'; 
import handleClerkWebhook from './lib/clerkWebhookHandler.js';
import whatsAppInstanceRouter from './lib/whatsappInstanceHandler.js'; // NOVA IMPORTAÇÃO
import stripeRouter from './lib/stripeRoutes.js'; // IMPORTAÇÃO DO STRIPE

import { buildShopifySystemPrompt, fetchSpecificProductDetails, getSystemPromptRawTemplate, fetchOrderDetails, fetchUserKnowledgeBase } from './lib/promptBuilder.js'; 
import { getTrackingInfo17Track, registerSingleTrackingNumber17Track } from './lib/trackingService.js';

// Importar o serviço de intervenção humana
import { HumanInterventionService } from './lib/humanInterventionService.js';

// Importar e iniciar o job de limpeza de intervenções
import './lib/interventionCleanupJob.js';

// Importar e iniciar o job de limpeza de proteção contra loops
import './lib/loopProtectionCleanupJob.js';

import helpdeskRouter from './lib/admin/helpdeskRoutes.js'; // IMPORTAÇÃO DO HELPDESK

// Importar rotas que existem
import dashboardRoutes from './lib/dashboardRoutes.js';

// Import admin routes
import adminRoutes from './lib/admin/adminRoutes.js';

const shopify = getShopifyInstance();

(async () => {
  console.log('[IMMEDIATE TEST] Attempting direct SELECT from "OpenAIKeys" after client init...');
  try {
    const { data, error } = await supabase.from('OpenAIKeys').select('clerk_user_id').limit(1);
    if (error) {
      console.error('[IMMEDIATE TEST] Error during SELECT:', JSON.stringify(error, null, 2));
    } else {
      console.log('[IMMEDIATE TEST] SELECT successful. Data:', data);
    }
  } catch (e) {
    console.error('[IMMEDIATE TEST] Catastrophic error during SELECT:', e);
  }
})();

const app = express();
const port = process.env.PORT || 3001;

const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
const ngrokUrl = process.env.NGROK_URL;
const allowedOrigins = [frontendUrl];
if (ngrokUrl && ngrokUrl !== frontendUrl) {
  allowedOrigins.push(ngrokUrl);
}
console.log('[CORS] Allowed Origins:', allowedOrigins);
const corsOptions = {
  origin: function (origin, callback) {
    console.log('[CORS] Request Origin:', origin);
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn('[CORS] Blocked by CORS. Origin not allowed:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.use(cookieParser());

// --- CLERK MIDDLEWARE ---
// Deve ser registrado ANTES das rotas que precisam de autenticação
// Excluir rotas admin do middleware do Clerk
app.use((req, res, next) => {
  if (req.path.startsWith('/api/admin')) {
    return next();
  }
  return clerkMiddleware()(req, res, next);
});

// --- WEBHOOK DO CLERK ---
// A rota do webhook do Clerk DEVE ser registrada ANTES do parsing de JSON,
// pois o Clerk precisa do corpo bruto (raw body) para verificar a assinatura.
app.post('/api/clerk/webhook', express.raw({ type: 'application/json' }), handleClerkWebhook);

// --- WEBHOOK DO STRIPE ---
// IMPORTANTE: O webhook do Stripe DEVE ser registrado ANTES do express.json()
// para que receba o raw body necessário para verificação da assinatura
app.post('/api/stripe/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let event;
  
  try {
    // Importar stripe aqui para evitar problemas de dependência
    const { stripe } = await import('./lib/stripeClient.js');
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('[Stripe Webhook] Erro de assinatura:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  
  console.log('[Stripe Webhook] Evento recebido:', event.type);
  
  try {
    // Importar os services aqui
    const subscriptionService = (await import('./lib/subscriptionService.js')).default;
    const usageService = (await import('./lib/usageService.js')).default;
    
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionChange(event.data.object, subscriptionService);
        break;
        
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object, subscriptionService);
        break;
        
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object, usageService);
        break;
        
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
        
      default:
        console.log('[Stripe Webhook] Evento não tratado:', event.type);
    }
    
    res.json({received: true});
    
  } catch (error) {
    console.error('[Stripe Webhook] Erro ao processar:', error);
    res.status(500).json({ error: 'Erro no webhook' });
  }
});

// Funções auxiliares do webhook
async function handleSubscriptionChange(subscription, subscriptionService) {
  const clerkUserId = subscription.metadata?.clerk_user_id;
  
  if (!clerkUserId) {
    console.error('[Webhook] clerk_user_id ausente:', subscription.id);
    return;
  }
  
  // Determinar plano baseado no price_id
  let planType = 'core';
  if (subscription.items?.data?.length > 0) {
    const priceId = subscription.items.data[0].price.id;
    if (priceId === process.env.STRIPE_PRICE_NEURAL_ID) {
      planType = 'neural';
    } else if (priceId === process.env.STRIPE_PRICE_NIMBUS_ID) {
      planType = 'nimbus';
    } else if (priceId === process.env.STRIPE_PRICE_NEURAL_ANNUAL_ID) {
      planType = 'neural_annual';
    } else if (priceId === process.env.STRIPE_PRICE_NIMBUS_ANNUAL_ID) {
      planType = 'nimbus_annual';
    }
  }
  
  console.log(`[Webhook] Sincronizando subscription ${subscription.id}: plano ${planType} para usuário ${clerkUserId}`);
  
  const planInfo = {
    core: { limit: 500 },
    neural: { limit: 5000 },
    neural_annual: { limit: 5000 },
    nimbus: { limit: 15000 },
    nimbus_annual: { limit: 15000 }
  };
  
  await subscriptionService.updateSubscriptionByClerkId(clerkUserId, {
    stripe_subscription_id: subscription.id,
    stripe_customer_id: subscription.customer,
    plan_type: planType,
    status: subscription.status,
    current_period_start: new Date(subscription.current_period_start * 1000),
    current_period_end: new Date(subscription.current_period_end * 1000),
    monthly_message_limit: planInfo[planType].limit
  });
}

async function handleSubscriptionDeleted(subscription, subscriptionService) {
  const clerkUserId = subscription.metadata?.clerk_user_id;
  
  if (!clerkUserId) {
    console.error('[Webhook] clerk_user_id ausente na subscription deleted:', subscription.id);
    return;
  }
  
  console.log(`[Webhook] Assinatura cancelada: ${subscription.id} para usuário ${clerkUserId}`);
  
  // Voltar para plano Core
  await subscriptionService.updateSubscriptionByClerkId(clerkUserId, {
    stripe_subscription_id: null,
    plan_type: 'core',
    status: 'canceled',
    current_period_start: null,
    current_period_end: null,
    monthly_message_limit: 500
  });
}

async function handlePaymentSucceeded(invoice, usageService) {
  const subscription = invoice.subscription;
  if (subscription) {
    console.log(`[Webhook] Pagamento bem-sucedido para subscription: ${subscription}`);
    // Resetar uso mensal se necessário
    const clerkUserId = invoice.customer_details?.metadata?.clerk_user_id;
    if (clerkUserId) {
      await usageService.resetMonthlyUsage(clerkUserId);
    }
  }
}

async function handlePaymentFailed(invoice) {
  const subscription = invoice.subscription;
  if (subscription) {
    console.log(`[Webhook] Falha no pagamento para subscription: ${subscription}`);
    // Aqui pode implementar notificações, downgrade temporário, etc.
  }
}

app.use(express.json({
  verify: (req, res, buf, encoding) => {
    if (buf && buf.length) {
      req.rawBody = buf.toString(encoding || 'utf8');
    }
  }
}));
app.use(express.urlencoded({
  extended: true,
  verify: (req, res, buf, encoding) => {
    if (buf && buf.length) {
      req.rawBody = buf.toString(encoding || 'utf8');
    }
  }
}));

// --- CONECTA O ROUTER DO CHAT ---
app.use('/api/chat', chatRouter);

// --- CONECTA O ROUTER DO STRIPE (exceto webhook que já foi tratado acima) ---
app.use('/api/stripe', (req, res, next) => {
  // Pular o webhook que já foi tratado acima
  if (req.path === '/webhook') {
    return res.status(404).json({ error: 'Webhook já tratado em rota específica' });
  }
  next();
}, stripeRouter);
app.use('/api/usage', stripeRouter);

// --- ROTA PARA WEBHOOK DA EVOLUTION API ---
app.post('/api/evolution/webhook/:secretToken', (req, res, next) => {
  console.log(`[INDEX.JS WEBHOOK] Rota /api/evolution/webhook/${req.params.secretToken ? req.params.secretToken.substring(0,5) + '...' : 'NO_TOKEN'} ATINGIDA!`);
  console.log(`[INDEX.JS WEBHOOK] Headers: Content-Type: ${req.headers['content-type']}`);
  
  // Adicionamos um novo middleware de parsing de JSON aqui, APENAS para esta rota, para capturar erros
  express.json({
    verify: (req, res, buf, encoding) => {
      if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
        // console.log('[INDEX.JS WEBHOOK] RawBody capturado pelo verify interno.');
      }
    }
  })(req, res, (err) => {
    if (err) {
      console.error('[INDEX.JS WEBHOOK] Erro no parsing do JSON:', err);
      // Se houver erro no parsing, err.statusCode é frequentemente 400
      return res.status(err.statusCode || 400).json({ 
        message: 'Erro ao processar o corpo da requisição JSON.', 
        error: err.message,
        type: err.type 
      });
    }
    // Se não houve erro no parsing, req.body deve estar populado.
    // console.log('[INDEX.JS WEBHOOK] JSON parseado com sucesso. req.body existe:', !!req.body);
    
    // Agora chame o handler principal
    handleEvolutionWebhook(req, res, next); // O next original é passado
  });
});

// --- ROTAS DE INSTÂNCIA DO WHATSAPP (AGORA EM UM HANDLER SEPARADO) ---
app.use('/api/whatsapp/instance', whatsAppInstanceRouter); // USANDO O NOVO ROUTER

// --- verifyShopifyWebhook e rotas Shopify /api/shopify/... permanecem aqui ---
// ... (todo o bloco de verifyShopifyWebhook e as rotas /api/shopify/...)

const verifyShopifyWebhook = (req, res, next) => {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  const shopifyApiSecret = process.env.SHOPIFY_API_SECRET;
  if (!hmacHeader) {
    console.warn('[Webhook Shopify] HMAC header ausente. Acesso negado.');
    return res.status(401).send('HMAC validation failed: Missing HMAC header');
  }
  if (!shopifyApiSecret) {
    console.error('[Webhook Shopify] SHOPIFY_API_SECRET não configurado no servidor.');
    return res.status(500).send('Internal server error: Webhook secret not configured');
  }
  const bodyToHash = req.rawBody;
  if (!bodyToHash) {
    console.error('[Webhook Shopify] Corpo bruto (rawBody) não disponível para verificação HMAC.');
    return res.status(500).send('Internal server error: Raw body not available for HMAC verification.');
  }
  try {
    const generatedHash = crypto.createHmac('sha256', shopifyApiSecret).update(bodyToHash, 'utf8').digest('base64');
    const trusted = Buffer.from(generatedHash, 'base64');
    const untrusted = Buffer.from(hmacHeader, 'base64');
    if (trusted.length === untrusted.length && crypto.timingSafeEqual(trusted, untrusted)) {
      console.log('[Webhook Shopify] Verificação HMAC bem-sucedida.');
      next();
    } else {
      console.warn('[Webhook Shopify] Falha na verificação HMAC. Hashes não correspondem.');
      return res.status(403).send('HMAC validation failed: Hashes do not match');
    }
  } catch (error) {
    console.error('[Webhook Shopify] Erro durante a verificação HMAC:', error);
    return res.status(500).send('Error during HMAC validation');
  }
};

app.post("/api/shopify/webhooks/fulfillment_events", verifyShopifyWebhook, async (req, res) => {
  // ... (lógica existente da rota)
  const shopDomain = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');
  const webhookId = req.get('X-Shopify-Webhook-Id');
  const fulfillment = req.body;
  console.log(`[Webhook Shopify Fulfillment] Recebido para loja ${shopDomain}, Tópico: ${topic}, ID: ${webhookId}`);

  if (!shopDomain) {
    console.warn('[Webhook Shopify Fulfillment] X-Shopify-Shop-Domain header ausente.');
    return res.status(400).send('Missing X-Shopify-Shop-Domain header');
  }

  async function getShopifyAccessTokenInternal(domain) { 
    try {
      const { data, error } = await supabase.from('shopify_sessions').select('access_token').eq('shop', domain).single();
      if (error) {
        console.error(`[Webhook SF Fulfillment] Erro ao buscar accessToken para ${domain}:`, error);
        return null;
      }
      return data ? data.access_token : null;
    } catch (e) {
      console.error(`[Webhook SF Fulfillment] Exceção ao buscar accessToken para ${domain}:`, e);
      return null;
    }
  }
  const shopifyAccessToken = await getShopifyAccessTokenInternal(shopDomain);
  if (!shopifyAccessToken) {
    console.warn(`[Webhook SF Fulfillment] Não foi possível obter o accessToken para ${shopDomain}.`);
  }

  if (topic === "fulfillments/create" || topic === "fulfillments/update") {
    if (fulfillment.tracking_numbers && fulfillment.tracking_numbers.length > 0) {
      for (const trackingNumber of fulfillment.tracking_numbers) {
        const carrierName = fulfillment.tracking_company;
        let carrierCode17Track = null;
        const isCorreiosBrazilFormat = (tn) => {
          if (typeof tn === 'string') {
            const regexTest = /^[A-Za-z]{2}[A-Za-z0-9]{9}[A-Za-z]{2}$/.test(tn);
            const endsWithBR = tn.toUpperCase().endsWith('BR');
            return regexTest && endsWithBR;
          }
          return false;
        };
        if (carrierName && typeof carrierName === 'string') {
          const normalizedCarrierName = carrierName.toLowerCase().trim();
          if (normalizedCarrierName.includes("correios")) {
            carrierCode17Track = "3031";
          } else if (normalizedCarrierName === 'outra' || normalizedCarrierName === 'other') {
            if (isCorreiosBrazilFormat(trackingNumber)) {
              carrierCode17Track = "3031";
            }
          }
        } else if (isCorreiosBrazilFormat(trackingNumber)) {
          carrierCode17Track = "3031";
        }
        try {
          const registrationResult = await registerSingleTrackingNumber17Track(trackingNumber, carrierCode17Track);
          let statusToSave = 'REGISTRATION_ATTEMPTED';
          let rawResponseToSave = JSON.stringify(registrationResult);
          if (registrationResult && registrationResult.success) {
            statusToSave = 'REGISTERED_ON_17TRACK';
          } else if (registrationResult && !registrationResult.success) {
            statusToSave = 'REGISTRATION_FAILED_17TRACK';
            if (registrationResult.details && registrationResult.details.error && registrationResult.details.error.code) {
              const errorCode = registrationResult.details.error.code;
              if (errorCode === -18019908) {
                statusToSave = 'ALREADY_REGISTERED_17TRACK';
              } else if (errorCode === -18010001) {
                statusToSave = 'PROCESSING_BY_17TRACK';
              }
            }
          }
          const { data: existingTracking, error: selectError } = await supabase.from('ShopifyTrackings').select('id').eq('shop_domain', shopDomain).eq('tracking_number', trackingNumber).single();
          if (selectError && selectError.code !== 'PGRST116') {
            console.error(`[Webhook SF Fulfillment] Erro ao verificar tracking existente para ${trackingNumber}:`, selectError);
          } else if (existingTracking) {
            const { error: updateError } = await supabase.from('ShopifyTrackings').update({order_id: String(fulfillment.order_id),carrier_name: carrierName || null,carrier_code_17track: carrierCode17Track,status_17track: statusToSave,last_17track_raw_response: rawResponseToSave,updated_at: new Date().toISOString()}).eq('id', existingTracking.id);
            if (updateError) console.error(`[Webhook SF Fulfillment] Erro ao ATUALIZAR tracking ${trackingNumber}:`, updateError);
            } else {
            const { error: insertError } = await supabase.from('ShopifyTrackings').insert([{shop_domain: shopDomain,order_id: String(fulfillment.order_id),tracking_number: trackingNumber,carrier_name: carrierName || null,carrier_code_17track: carrierCode17Track,status_17track: statusToSave,last_17track_raw_response: rawResponseToSave}]);
            if (insertError) console.error(`[Webhook SF Fulfillment] Erro ao INSERIR tracking ${trackingNumber}:`, insertError);
          }
        } catch (error) {
          console.error(`[Webhook SF Fulfillment] Erro ao registrar/salvar ${trackingNumber}:`, error);
        }
      }
    }
    res.status(200).send("Webhook de fulfillment processado.");
  } else {
    res.status(200).send("Webhook recebido, mas não aplicável (fulfillment).");
  }
});

app.get('/ping', (req, res) => {
  console.log('[Backend Test] Rota /ping ATINGIDA!');
  res.status(200).send('pong');
});

app.get('/app-launch', (req, res) => {
  const frontendIntegrationsUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard/integracoes`;
  console.log(`[App Launch] Rota /app-launch atingida. Redirecionando para: ${frontendIntegrationsUrl}`);
  res.redirect(frontendIntegrationsUrl);
});

app.get('/api/shopify/auth', async (req, res) => {
  // ... (lógica existente da rota)
  console.log('[Backend Shopify Auth GET] ROTA /api/shopify/auth ATINGIDA!');
  const { shop: shopParam } = req.query;
  const clerkUserId = "user_2wkfKumZYa78726YfpXgwNRSOSU"; // ID FIXO PARA TESTE
  if (!clerkUserId || !shopParam) return res.status(400).send('Missing params');
  try {
    res.cookie('shopify_clerk_user_id', clerkUserId, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 5 * 60 * 1000, sameSite: 'lax' 
    });
    await shopify.auth.begin({
      shop: shopParam, callbackPath: '/api/shopify/auth/callback', isOnline: false, rawRequest: req, rawResponse: res, 
    });
  } catch (error) {
    console.error('[Backend Shopify Auth GET] ERRO NO CATCH block:', error);
    if (!res.headersSent) {
        res.status(500).json({ message: 'Erro interno ao iniciar autenticação Shopify.', errorDetails: error.message || 'Detalhes não disponíveis', errorStack: error.stack?.substring(0,500) });
    }
  }
});

app.get('/api/shopify/auth/callback', async (req, res) => {
  console.log('[Backend ESM Shopify Callback] ROTA DE CALLBACK ATINGIDA. Query:', req.query);
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const clerkUserIdFromCookie = req.cookies.shopify_clerk_user_id;
  res.clearCookie('shopify_clerk_user_id');
  if (!clerkUserIdFromCookie) {
    console.error('[Backend ESM Shopify Callback] Cookie shopify_clerk_user_id não encontrado.');
    return res.redirect(`${frontendUrl}/dashboard/integracoes?shopify_error=true&message=${encodeURIComponent('Falha ao associar usuário. Tente novamente.')}`);
  }
  try {
    const callbackResponse = await shopify.auth.callback({ rawRequest: req, rawResponse: res });
    const { session } = callbackResponse;
    session.clerk_user_id = clerkUserIdFromCookie; 
    const stored = await shopify.config.sessionStorage.storeSession(session);
    if (!stored) {
      console.error(`[Backend ESM Shopify Callback] FALHA ao armazenar sessão Shopify com Clerk User ID ${clerkUserIdFromCookie} para loja ${session.shop}`);
      return res.redirect(`${frontendUrl}/dashboard/integracoes?shopify_error=true&message=${encodeURIComponent('Erro ao associar sessão ao usuário.')}`);
    }
    if (shopify && shopify.webhooks && typeof shopify.webhooks.register === 'function') {
        const registrationResponse = await shopify.webhooks.register({ session: session });
        const checkTopicRegistration = (topic) => {
          if (registrationResponse[topic]) {
            registrationResponse[topic].forEach((result, index) => {
            if (!result.success) console.error(`[Backend ESM Shopify Callback] Falha ao registrar webhook para ${topic} (resultado ${index + 1}):`, result.result);
          });
        }
      };
        checkTopicRegistration('FULFILLMENTS_CREATE');
        checkTopicRegistration('FULFILLMENTS_UPDATE');
    }
    res.redirect(`${frontendUrl}/dashboard/integracoes?shopify_connected=true&shop=${encodeURIComponent(session.shop)}`);
  } catch (error) {
    console.error('[Backend ESM Shopify Callback] Erro no callback:', error);
    if (error.response) console.error('[Backend ESM] Shopify API HttpError details (callback):', JSON.stringify(error.response.body, null, 2));
    res.redirect(`${frontendUrl}/dashboard/integracoes?shopify_error=true&message=${encodeURIComponent(error.message || 'Erro interno no callback da Shopify.')}`);
  }
});

app.get('/api/shopify/session/status', requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId;
  try {
    const currentSession = await shopify.config.sessionStorage.findSessionByClerkId(clerkUserId);
    if (currentSession && currentSession.accessToken) { 
      return res.json({ connected: true, shop: currentSession.shop });
    } else {
      return res.json({ connected: false, shop: null });
    }
  } catch (error) {
    return res.status(500).json({ connected: false, shop: null, message: 'Erro interno.' });
  }
});

app.post('/api/shopify/session/disconnect', requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId;
  const { shop } = req.body;
  if(!shop) return res.status(400).json({success: false, message: 'Shop é obrigatório'});
  try {
    const { count, error: deleteError } = await supabase.from('shopify_sessions').delete().match({ clerk_user_id: clerkUserId, shop: shop });
    if (deleteError) throw deleteError;
    console.log(`[Shopify Disconnect] Sessões deletadas: ${count}`);
    res.status(200).json({ success: true, message: 'Desconectado.' });
  } catch (error) {
    console.error(`[Shopify Disconnect] Erro:`, error);
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

// --- ROTAS OPENAI ---

// Rota para salvar/atualizar a API Key da OpenAI
app.post('/api/openai/config/save', requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId;
  const { apiKey } = req.body;

  if (!clerkUserId) {
    return res.status(401).json({ message: 'Usuário não autenticado.' });
  }
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    return res.status(400).json({ message: 'API Key da OpenAI é obrigatória.' });
  }

  try {
    // Verifica se a chave de criptografia está disponível e válida
    // getEncryptionKey() já lança um erro se a chave não estiver configurada ou for inválida.
    getEncryptionKey(); 
    console.log('[OpenAI Config] Chave de criptografia verificada.');

    console.log(`[OpenAI Config] Validando API Key para o usuário ${clerkUserId}...`);
    const openai = new OpenAI({ apiKey: apiKey }); // Usa a chave fornecida diretamente para validação
    await openai.models.list(); // Tenta listar modelos para validar a chave
    console.log(`[OpenAI Config] API Key validada com sucesso para o usuário ${clerkUserId}.`);

    const encryptedApiKeyToSave = encrypt(apiKey);

    // Upsert: Insere ou atualiza a chave se já existir para o usuário
    const { data, error } = await supabase
      .from('OpenAIKeys') // Certifique-se que este é o nome correto da sua tabela
      .upsert(
        { clerk_user_id: clerkUserId, encrypted_api_key: encryptedApiKeyToSave, updated_at: new Date().toISOString() }, // CORRIGIDO AQUI
        { onConflict: 'clerk_user_id' } // Se houver conflito na coluna clerk_user_id, atualiza
      )
      .select();

    if (error) {
      console.error(`[OpenAI Config] Erro ao salvar API Key no Supabase para ${clerkUserId}:`, error);
      return res.status(500).json({ message: 'Erro ao salvar a configuração da API Key.', details: error });
    }

    console.log(`[OpenAI Config] API Key salva com sucesso para ${clerkUserId}.`);
    res.status(200).json({ success: true, message: 'API Key da OpenAI configurada com sucesso.' });

  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      console.warn(`[OpenAI Config] API Key inválida para ${clerkUserId}. Erro OpenAI: ${error.status} ${error.name}`, error.message);
      return res.status(400).json({ message: `API Key da OpenAI inválida. Detalhes: ${error.message || error.name}` });
    }
    console.error(`[OpenAI Config] Erro interno ao configurar API Key para ${clerkUserId}:`, error);
    // Se o erro for da validação da getEncryptionKey, o catch já tratará
    // Se for outro erro, retorna 500
    if (error.message === 'Chave de criptografia inválida ou não configurada.') {
      // Este erro específico já foi logado por getEncryptionKey
      return res.status(500).json({ message: 'Erro interno do servidor: Configuração de criptografia ausente ou inválida.' });
    }
    res.status(500).json({ message: 'Erro interno do servidor ao configurar API Key.', details: error.message });
  }
});

// Rota para verificar o status da configuração da API Key da OpenAI
app.get('/api/openai/config/status', requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId;

  if (!clerkUserId) {
    return res.status(401).json({ message: 'Usuário não autenticado.' });
  }
  
  try {
    const { data, error } = await supabase
      .from('OpenAIKeys')
      .select('clerk_user_id') // Seleciona qualquer coluna para verificar existência
      .eq('clerk_user_id', clerkUserId)
      .maybeSingle();

    if (error) {
      console.error(`[OpenAI Status] Erro ao verificar API Key no Supabase para ${clerkUserId}:`, error);
      return res.status(500).json({ message: 'Erro ao verificar status da configuração.', details: error });
    }

    if (data) {
      console.log(`[OpenAI Status] Configuração encontrada para ${clerkUserId}.`);
      res.status(200).json({ configured: true });
    } else {
      console.log(`[OpenAI Status] Nenhuma configuração encontrada para ${clerkUserId}.`);
      res.status(200).json({ configured: false });
    }
  } catch (error) {
    console.error(`[OpenAI Status] Erro interno ao verificar status para ${clerkUserId}:`, error);
    res.status(500).json({ message: 'Erro interno do servidor ao verificar status.', details: error.message });
  }
});

// Rota para desconectar/remover a API Key da OpenAI
app.post('/api/openai/config/disconnect', requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId;

  if (!clerkUserId) {
    return res.status(401).json({ message: 'Usuário não autenticado.' });
  }

  try {
    const { error, count } = await supabase
      .from('OpenAIKeys')
      .delete()
      .eq('clerk_user_id', clerkUserId);

    if (error) {
      console.error(`[OpenAI Disconnect] Erro ao remover API Key do Supabase para ${clerkUserId}:`, error);
      return res.status(500).json({ message: 'Erro ao remover a configuração da API Key.', details: error });
    }

    if (count === 0) {
      console.warn(`[OpenAI Disconnect] Nenhuma API Key encontrada para remover para o usuário ${clerkUserId}.`);
      // Considerar sucesso, pois o estado desejado é alcançado.
    } else {
      console.log(`[OpenAI Disconnect] API Key removida com sucesso para ${clerkUserId}.`);
    }
    
    res.status(200).json({ success: true, message: 'Configuração da API Key da OpenAI removida com sucesso.' });

  } catch (error) {
    console.error(`[OpenAI Disconnect] Erro interno ao desconectar API Key para ${clerkUserId}:`, error);
    res.status(500).json({ message: 'Erro interno do servidor ao desconectar API Key.', details: error.message });
  }
});

// --- NOVA ROTA PARA VISUALIZAR O SYSTEM PROMPT ---
app.get("/api/ia/system-prompt", requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId; 
  const { shopDomain } = req.query; 

  console.log(`[API System Prompt] Rota acessada. User ID: ${clerkUserId}, Shop Domain: ${shopDomain}`);

    if (!shopDomain) {
    return res.status(400).json({ error: "O parâmetro 'shopDomain' é obrigatório." });
  }

  const shopifySession = await getShopifySession(String(shopDomain)); // Adicionado String() para garantir

  if (!shopifySession) {
    console.warn(`[API System Prompt] Não foi possível carregar a sessão da Shopify para ${shopDomain}. Retornando prompt genérico ou de erro.`);
  }

  try {
    // BUSCAR BASE DE CONHECIMENTO DO USUÁRIO
    let userKnowledgeBase = null;
    try {
      userKnowledgeBase = await fetchUserKnowledgeBase(clerkUserId);
    } catch (knowledgeError) {
      console.warn(`[API System Prompt] Erro ao buscar base de conhecimento para usuário ${clerkUserId}:`, knowledgeError);
    }

    const systemPrompt = await buildShopifySystemPrompt({
      shopName: String(shopDomain), // Adicionado String()
      shopify: shopify,
      shopifySession: shopifySession,
      knowledgeBaseContent: userKnowledgeBase ? userKnowledgeBase.content : null
    });

    if (!systemPrompt) {
        console.error("[API System Prompt] buildShopifySystemPrompt retornou nulo ou indefinido.");
        return res.status(500).json({ error: "Falha ao gerar o prompt do sistema."});
    }

    console.log(`[API System Prompt] Prompt gerado com sucesso para ${shopDomain}. Tamanho: ${systemPrompt.length} caracteres.`);
    res.status(200).json({ systemPrompt: systemPrompt });

  } catch (error) { 
    console.error(`[API System Prompt] Erro ao gerar system prompt para ${shopDomain}:`, error);
    res.status(500).json({ error: "Erro interno ao gerar o prompt do sistema.", details: (error instanceof Error ? error.message : String(error)) });
  }
});

// ROTA PARA BUSCAR TODAS AS PÁGINAS DA LOJA SHOPIFY DO USUÁRIO
app.get('/api/shopify/pages', requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId;

  if (!clerkUserId) {
    return res.status(401).json({ error: "Usuário não autenticado." });
  }

  try {
    console.log(`[Shopify Pages] Buscando sessão Shopify ativa para clerk_user_id ${clerkUserId}`);
    const currentShopifySession = await shopify.config.sessionStorage.findSessionByClerkId(clerkUserId);

    if (!currentShopifySession || !currentShopifySession.shop) {
      console.error(`[Shopify Pages] Nenhuma sessão Shopify ativa ou nome da loja (shop) não encontrado para clerk_user_id ${clerkUserId}. Session:`, currentShopifySession);
      return res.status(404).json({ error: "Nenhuma loja Shopify conectada encontrada para este usuário." });
    }

    const shopDomain = currentShopifySession.shop;
    console.log(`[Shopify Pages] Loja Shopify encontrada: ${shopDomain} para clerk_user_id ${clerkUserId}`);

    let sessionToUse = currentShopifySession;
    if (!currentShopifySession.accessToken) {
        console.warn(`[Shopify Pages] Sessão de findSessionByClerkId para ${shopDomain} não tem accessToken. Tentando carregar via getShopifySession.`);
        sessionToUse = await getShopifySession(shopDomain);
    }

    if (!sessionToUse || !sessionToUse.accessToken) {
      console.error(`[Shopify Pages] Não foi possível obter uma sessão Shopify válida com accessToken para ${shopDomain}`);
      return res.status(500).json({ error: "Não foi possível obter a sessão da Shopify com token de acesso." });
    }

    console.log(`[Shopify Pages] Usando sessão para ${shopDomain} para buscar páginas. API Version da sessão: ${sessionToUse.apiVersion || LATEST_API_VERSION}`);

    const client = new shopify.clients.Rest({ 
        session: sessionToUse,
    });

    const response = await client.get({
      path: 'pages',
      query: {
        fields: 'id,title,body_html,handle,shop_id',
        limit: 250
      }
    });

    if (response.body && Array.isArray(response.body.pages)) {
        const pages = response.body.pages;
        console.log(`[Shopify Pages] ${pages.length} páginas encontradas para ${shopDomain}.`);
        return res.status(200).json(pages);
    } else {
        console.error(`[Shopify Pages] Resposta inesperada da API Shopify ao buscar páginas para ${shopDomain}. Corpo:`, response.body);
        return res.status(500).json({ error: "Resposta inesperada da API Shopify ao buscar páginas." });
    }

  } catch (error) {
    console.error(`[Shopify Pages] Erro ao buscar páginas da Shopify para o usuário ${clerkUserId}:`, (error instanceof Error ? error.message : String(error)));
    console.error('[Shopify Pages] Detalhes do erro:', error);

    let statusCode = 500;
    let errorMessage = "Erro interno do servidor ao buscar páginas da Shopify.";

    if (error && typeof error === 'object' && 'response' in error && error.response && typeof error.response === 'object' && 'statusCode' in error.response) {
      const shopifyError = error;
      statusCode = shopifyError.response.statusCode;
      if (shopifyError.response.body && shopifyError.response.body.errors) {
          if (typeof shopifyError.response.body.errors === 'string') {
              errorMessage = shopifyError.response.body.errors;
          } else if (typeof shopifyError.response.body.errors === 'object') {
              errorMessage = Object.entries(shopifyError.response.body.errors)
                                   .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
                                   .join('; ');
          } else {
            errorMessage = `Erro da API Shopify (código ${statusCode})`;
          }
      } else {
        errorMessage = (shopifyError instanceof Error ? shopifyError.message : `Erro da API Shopify (código ${statusCode})`);
      }
    }
    
    return res.status(statusCode).json({ error: errorMessage, details: (error instanceof Error ? error.message : String(error)) });
  }
});

// ROTA PARA BUSCAR O CONTEÚDO DE UMA PÁGINA ESPECÍFICA DA SHOPIFY PELO HANDLE
app.get('/api/shopify/page_content_by_handle', requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId;
  const { handle } = req.query; 

  if (!clerkUserId) {
    return res.status(401).json({ error: "Usuário não autenticado." });
  }
  if (!handle || typeof handle !== 'string') {
    return res.status(400).json({ error: "O parâmetro 'handle' da página é obrigatório." });
  }

  try {
    console.log(`[Shopify Page Content] Buscando sessão Shopify ativa para clerk_user_id ${clerkUserId}`);
    const currentShopifySession = await shopify.config.sessionStorage.findSessionByClerkId(clerkUserId);

    if (!currentShopifySession || !currentShopifySession.shop) {
      console.error(`[Shopify Page Content] Nenhuma sessão Shopify ativa ou nome da loja (shop) não encontrado para clerk_user_id ${clerkUserId}.`);
      return res.status(404).json({ error: "Nenhuma loja Shopify conectada encontrada para este usuário." });
    }
    const shopDomain = currentShopifySession.shop;

    let sessionToUse = currentShopifySession;
    if (!currentShopifySession.accessToken) {
        console.warn(`[Shopify Page Content] Sessão de findSessionByClerkId para ${shopDomain} não tem accessToken. Tentando carregar via getShopifySession.`);
        sessionToUse = await getShopifySession(shopDomain);
    }

    if (!sessionToUse || !sessionToUse.accessToken) {
      console.error(`[Shopify Page Content] Não foi possível obter uma sessão Shopify válida com accessToken para ${shopDomain}`);
      return res.status(500).json({ error: "Não foi possível obter a sessão da Shopify com token de acesso." });
    }

    console.log(`[Shopify Page Content] Buscando conteúdo da página com handle '${handle}' para a loja: ${shopDomain}`);

    const client = new shopify.clients.Rest({ session: sessionToUse });

    const response = await client.get({
      path: 'pages',
      query: {
        handle: handle, 
        fields: 'id,title,handle,body_html'
      }
    });

    if (response.body && Array.isArray(response.body.pages) && response.body.pages.length > 0) {
      const page = response.body.pages[0]; 
      if (page.handle === handle) {
        const textContent = htmlToText(page.body_html, {
          wordwrap: false, 
          selectors: [ 
            { selector: 'script', format: 'skip' },
            { selector: 'style', format: 'skip' },
            { selector: 'nav', format: 'skip' },
            { selector: 'footer', format: 'skip' },
            { selector: 'a', options: { ignoreHref: true } } 
          ]
        });
        console.log(`[Shopify Page Content] Conteúdo da página '${page.title}' (handle: ${handle}) encontrado e convertido para texto.`);
        return res.status(200).json({ title: page.title, handle: page.handle, content: textContent });
    } else {
        console.warn(`[Shopify Page Content] Página encontrada pela API, mas o handle não corresponde exatamente. API handle: ${page.handle}, Requested handle: ${handle}`);
        return res.status(404).json({ error: `Página com handle '${handle}' não encontrada.` });
      }
    } else if (response.body && Array.isArray(response.body.pages) && response.body.pages.length === 0){
      console.log(`[Shopify Page Content] Nenhuma página encontrada com o handle '${handle}' para ${shopDomain}.`);
      return res.status(404).json({ error: `Página com handle '${handle}' não encontrada.` });
    } else {
        console.error(`[Shopify Page Content] Resposta inesperada da API Shopify ao buscar página por handle '${handle}' para ${shopDomain}. Corpo:`, response.body);
        return res.status(500).json({ error: "Resposta inesperada da API Shopify ao buscar conteúdo da página." });
    }

  } catch (error) {
    console.error(`[Shopify Page Content] Erro ao buscar conteúdo da página com handle '${handle}' para usuário ${clerkUserId}:`, (error instanceof Error ? error.message : String(error)));
    let statusCode = 500;
    let errorMessage = "Erro interno do servidor ao buscar conteúdo da página.";
    if (error && typeof error === 'object' && 'response' in error && error.response && typeof error.response === 'object' && 'statusCode' in error.response) {
      const shopifyError = error;
      statusCode = shopifyError.response.statusCode;
      if (shopifyError.response.body && shopifyError.response.body.errors) {
          if (typeof shopifyError.response.body.errors === 'string') {
              errorMessage = shopifyError.response.body.errors;
          } else if (typeof shopifyError.response.body.errors === 'object') {
              errorMessage = Object.entries(shopifyError.response.body.errors)
                                   .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
                                   .join('; ');
          } else {
            errorMessage = `Erro da API Shopify (código ${statusCode})`;
          }
      } else {
        errorMessage = (shopifyError instanceof Error ? shopifyError.message : `Erro da API Shopify (código ${statusCode})`);
      }
    }
    return res.status(statusCode).json({ error: errorMessage, details: (error instanceof Error ? error.message : String(error)) });
  }
});

// --- ROTAS PARA HISTÓRICO DO PLAYGROUND DA IA ---
// Rota para LISTAR sessões de chat do Playground para o usuário
app.get('/api/ia/playground/history', requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId;
  console.log(`[Playground History] Buscando lista de sessões para usuário: ${clerkUserId}`);
  try {
    // Buscar sessões distintas com a última mensagem de cada uma
    const { data, error } = await supabase
      .from('PlaygroundChatHistory')
      .select('session_id, message_content, timestamp')
      .eq('clerk_user_id', clerkUserId)
      .order('timestamp', { ascending: false });

    if (error) {
      console.error('[Playground History] Erro ao buscar sessões de chat:', error);
      return res.status(500).json({ message: 'Erro ao buscar histórico de sessões.', details: error.message });
    }

    if (data && data.length > 0) {
      // Agrupar por session_id e pegar a última mensagem de cada sessão
      const sessionsMap = new Map();
      data.forEach(row => {
        if (!sessionsMap.has(row.session_id)) {
          sessionsMap.set(row.session_id, {
            session_id: row.session_id,
            last_message_timestamp: row.timestamp,
            last_message_content: row.message_content
          });
        }
      });

      const sessions = Array.from(sessionsMap.values());
      console.log(`[Playground History] ${sessions.length} sessões encontradas para ${clerkUserId}.`);
      
      const formattedSessions = sessions.map((session) => ({
        sessionId: session.session_id,
        lastMessageTimestamp: session.last_message_timestamp,
        lastMessagePreview: session.last_message_content ? session.last_message_content.substring(0, 50) + (session.last_message_content.length > 50 ? '...' : '') : 'Nenhuma prévia disponível',
        title: `Conversa de ${new Date(session.last_message_timestamp).toLocaleDateString('pt-BR')} ${new Date(session.last_message_timestamp).toLocaleTimeString('pt-BR')}`
      }));
      res.status(200).json(formattedSessions);
    } else {
      console.log(`[Playground History] Nenhuma sessão de chat encontrada para ${clerkUserId}.`);
      res.status(200).json([]); 
    }
  } catch (e) {
    const error = e;
    console.error('[Playground History] Exceção ao buscar lista de sessões:', error);
    res.status(500).json({ message: 'Exceção no servidor ao buscar histórico de sessões.', details: error.message });
  }
});

// Rota para BUSCAR todas as mensagens de uma sessão específica do Playground
app.get('/api/ia/playground/history/:chatSessionId', requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId;
  const { chatSessionId } = req.params;
  console.log(`[Playground History] Buscando mensagens para sessão ${chatSessionId}, usuário ${clerkUserId}`);
  if (!chatSessionId) {
    return res.status(400).json({ message: "ID da sessão de chat é obrigatório." });
  }
  try {
    const { data, error } = await supabase
      .from('PlaygroundChatHistory')
      .select('id, session_id, message_content, sender_type, channel, timestamp, metadata')
      .eq('clerk_user_id', clerkUserId)
      .eq('session_id', chatSessionId)
      .order('timestamp', { ascending: true }); 
    if (error) {
      console.error(`[Playground History] Erro ao buscar mensagens para sessão ${chatSessionId}:`, error);
      return res.status(500).json({ message: 'Erro ao buscar mensagens da sessão.', details: error.message });
    }
    if (data && data.length > 0) {
      console.log(`[Playground History] ${data.length} mensagens encontradas para sessão ${chatSessionId}.`);
      res.status(200).json(data);
    } else {
      console.log(`[Playground History] Nenhuma mensagem encontrada para sessão ${chatSessionId} (ou não pertence ao usuário).`);
      res.status(404).json({ message: 'Nenhuma mensagem encontrada para esta sessão.' }); 
    }
  } catch (e) {
    const error = e;
    console.error(`[Playground History] Exceção ao buscar mensagens para sessão ${chatSessionId}:`, error);
    res.status(500).json({ message: 'Exceção no servidor ao buscar mensagens da sessão.', details: error.message });
  }
});

// --- ADICIONAR HANDLERS DE WEBHOOK DA SHOPIFY ---

// Esta função de callback é um placeholder, pois a lógica principal já está na rota do webhook.
// Poderíamos usá-la para um log extra ou processamento leve síncrono se necessário.
const genericWebhookCallback = async (topic, shop, body, webhookId) => {
  console.log(`[Shopify Webhook Handler] Callback executado para Tópico: ${topic}, Loja: ${shop}, Webhook ID: ${webhookId}. O processamento principal ocorrerá na rota especificada.`);
  // Nenhuma ação adicional aqui é estritamente necessária se a rota /api/shopify/webhooks/fulfillment_events já lida com tudo.
};

if (shopify && shopify.webhooks && typeof shopify.webhooks.addHandlers === 'function') {
  console.log("[Shopify Webhooks] Configurando manipuladores de webhook...");
  shopify.webhooks.addHandlers({
    FULFILLMENTS_CREATE: [
      {
        deliveryMethod: DeliveryMethod.Http, // <-- USAR DeliveryMethod.Http
        callbackUrl: '/api/shopify/webhooks/fulfillment_events',
        callback: genericWebhookCallback, // A rota em si já tem a lógica
      },
    ],
    FULFILLMENTS_UPDATE: [
      {
        deliveryMethod: DeliveryMethod.Http, // <-- USAR DeliveryMethod.Http
        callbackUrl: '/api/shopify/webhooks/fulfillment_events',
        callback: genericWebhookCallback,
      },
    ],
    // Adicione outros webhooks que você possa precisar aqui, como ORDERS_PAID, etc.
    // Exemplo para ORDERS_PAID (se necessário no futuro):
    /*
    ORDERS_PAID: [
      {
        deliveryMethod: DeliveryMethod.Http, // Certifique-se que DeliveryMethod está importado
        callbackUrl: '/api/shopify/webhooks/order_paid_events', // Uma nova rota para isso
        callback: async (topic, shop, body) => {
          console.log(`[Shopify Webhook Handler] Pedido Pago: ${topic} para ${shop}`);
          // Lógica específica para pedidos pagos
        },
      },
    ],
    */
  });
  console.log("[Shopify Webhooks] Manipuladores de webhook configurados para FULFILLMENTS_CREATE e FULFILLMENTS_UPDATE.");
} else {
  console.error("[Shopify Webhooks] ERRO: shopify.webhooks.addHandlers não está disponível. Verifique a inicialização da Shopify API.");
}
// --- FIM DA ADIÇÃO DE HANDLERS DE WEBHOOK ---

// --- ROTAS PARA WEBHOOKS DE CONFORMIDADE GDPR DA SHOPIFY ---

// Endpoint para Solicitação de Dados do Cliente (customers/data_request)
app.post("/api/shopify/webhooks/gdpr/customers_data_request", verifyShopifyWebhook, async (req, res) => {
  const shopDomain = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');
  const webhookId = req.get('X-Shopify-Webhook-Id');
  const payload = req.body;

  console.log(`[GDPR Webhook] Recebido '${topic}' para loja ${shopDomain}, ID: ${webhookId}`);
  console.log(`[GDPR Webhook] Payload customers/data_request:`, JSON.stringify(payload, null, 2));

  // TODO: Implementar a lógica para coletar e fornecer os dados do cliente.
  // A Shopify espera uma resposta 200 OK. A entrega dos dados em si é feita por outros meios (ex: email para o lojista).
  // payload aqui conterá: { shop_id, shop_domain, customer: {id, email, phone}, orders_requested: [order_ids] }

  res.status(200).send("Webhook customers/data_request recebido.");
});

// Endpoint para Apagamento de Dados do Cliente (customers/redact)
app.post("/api/shopify/webhooks/gdpr/customers_redact", verifyShopifyWebhook, async (req, res) => {
  const shopDomain = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');
  const webhookId = req.get('X-Shopify-Webhook-Id');
  const payload = req.body;

  console.log(`[GDPR Webhook] Recebido '${topic}' para loja ${shopDomain}, ID: ${webhookId}`);
  console.log(`[GDPR Webhook] Payload customers/redact:`, JSON.stringify(payload, null, 2));

  // TODO: Implementar a lógica para apagar/anonimizar os dados do cliente.
  // payload aqui conterá: { shop_id, shop_domain, customer: {id, email, phone} }

  res.status(200).send("Webhook customers/redact recebido.");
});

// Endpoint para Apagamento de Dados da Loja (shop/redact)
app.post("/api/shopify/webhooks/gdpr/shop_redact", verifyShopifyWebhook, async (req, res) => {
  const shopDomain = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');
  const webhookId = req.get('X-Shopify-Webhook-Id');
  const payload = req.body;

  console.log(`[GDPR Webhook] Recebido '${topic}' para loja ${shopDomain}, ID: ${webhookId}`);
  console.log(`[GDPR Webhook] Payload shop/redact:`, JSON.stringify(payload, null, 2));

  // TODO: Implementar a lógica para apagar/anonimizar todos os dados relacionados à loja.
  // payload aqui conterá: { shop_id, shop_domain }

  res.status(200).send("Webhook shop/redact recebido.");
});
// --- FIM DAS ROTAS GDPR ---

// --- MIDDLEWARE CONDICIONAL DO CLERK ---
// O bloco abaixo será removido, pois o app.use(clerkMiddleware()) no início do arquivo já o substitui de forma mais eficaz.
/*
const clerkExpressMiddleware = clerkMiddleware({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  secretKey: process.env.CLERK_SECRET_KEY,
});

app.use((req, res, next) => {
  const pathsToSkipClerk = [
    '/api/shopify/webhooks/fulfillment_events',
    '/api/shopify/auth/callback',
    '/api/shopify/auth',
    '/api/evolution/webhook/'
  ];

  if (pathsToSkipClerk.some(path => req.path.startsWith(path))) {
    return next();
  }

  // A verificação de webhook do Clerk deve ser tratada aqui ou antes
  if (req.path.startsWith('/api/clerk/webhook')) {
      // O webhook do clerk precisa do corpo raw, então ele é tratado antes deste middleware.
      // Se a rota for a do webhook do Clerk, apenas passamos para o próximo handler.
    return next();
  }

  return clerkExpressMiddleware(req, res, next);
});
*/

// ROTA PARA BUSCAR HISTÓRICO DE CHAT POR SESSION ID (GERAL)
app.get('/api/chat/history/:sessionId', requireAuth(), async (req, res) => {
  const { sessionId } = req.params;
  const clerkUserId = req.auth.userId;

  if (!sessionId) {
    return res.status(400).json({ message: 'Session ID é obrigatório.' });
  }
  try {
    const { data, error } = await supabase
      .from('PlaygroundChatHistory')
      .select('id, clerk_user_id, session_id, message_content, sender_type, channel, timestamp, metadata')
      .eq('session_id', sessionId)
      .eq('clerk_user_id', clerkUserId)
      .order('timestamp', { ascending: true });

    if (error) {
      console.error('[API Get Chat History /api/chat/history] Erro Supabase:', JSON.stringify(error, null, 2));
      return res.status(500).json({ message: 'Erro ao buscar histórico do chat.', error: error.message });
    }
    res.status(200).json(data || []);
  } catch (e) {
    const error = e;
    console.error('[API Get Chat History /api/chat/history] Exceção:', error);
    res.status(500).json({ message: 'Exceção no servidor ao buscar histórico de sessões.', details: error.message });
  }
});

// ROTA PARA SALVAR HISTÓRICO DE CHAT (GERAL)
app.post('/api/chat/history', requireAuth(), async (req, res) => {
  const { sessionId, messageContent, senderType, channel } = req.body;
  const clerkUserId = req.auth.userId;

  if (!clerkUserId) {
    return res.status(401).json({ message: 'Usuário não autenticado.' });
  }
  if (!sessionId || !messageContent || !senderType) {
    return res.status(400).json({ message: 'sessionId, messageContent e senderType são obrigatórios.' });
  }
  if (senderType !== 'user' && senderType !== 'ai') {
    return res.status(400).json({ message: 'senderType deve ser "user" ou "ai".' });
  }
  const currentChannel = channel || 'unknown'; // Default para 'unknown' se não especificado

  try {
    const { data, error } = await supabase
      .from('PlaygroundChatHistory') // Usando a mesma tabela por enquanto
      .insert([{ 
        clerk_user_id: clerkUserId, 
        session_id: sessionId, 
        message_content: messageContent, 
        sender_type: senderType,
        channel: currentChannel 
      }])
      .select(); 
    if (error) {
      console.error('[API Save Chat History /api/chat/history] Erro Supabase:', error);
      return res.status(500).json({ message: 'Erro ao salvar mensagem.', error: error.message });
    }
    res.status(201).json(data && data[0] ? data[0] : {});
  } catch (e) {
    const error = e;
    console.error('[API Save Chat History /api/chat/history] Exceção:', error);
    res.status(500).json({ message: 'Erro interno do servidor.', error: error.message });
  }
});

// Rota para buscar as configurações da IA
app.get('/api/ai/settings', clerkMiddleware({}), requireAuth(), async (req, res) => {
  console.log('\n[BACKEND LOG] ROTA GET /api/ai/settings ATINGIDA! (Teste de Ordem)\n');
  // @ts-ignore
  const { userId } = req.auth;
  if (!userId) {
    return res.status(401).json({ error: "Usuário não autenticado." });
  }

  try {
    const { data, error } = await supabase
      .from('aisettings')
      .select('ai_name, ai_style, ai_language')
      .eq('clerk_user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') { 
        console.log(`[API /ai/settings] Nenhuma configuração de IA encontrada para o usuário ${userId}. Retornando defaults.`);
        return res.status(200).json({
          ai_name: 'Júlia', 
          ai_style: '',    
          ai_language: 'pt-br' 
        });
      }
      console.error(`[API /ai/settings] Erro ao buscar configurações da IA para o usuário ${userId}:`, error);
      throw error; 
    }

    if (data) {
      res.status(200).json(data);
    } else {
      console.log(`[API /ai/settings] Nenhuma configuração de IA encontrada (bloco else) para o usuário ${userId}. Retornando defaults.`);
      res.status(200).json({
        ai_name: 'Júlia',
        ai_style: '',
        ai_language: 'pt-br'
      });
    }
  } catch (error) {
    // @ts-ignore
    console.error(`[API /ai/settings] Catch final: Erro ao buscar configurações da IA para o usuário ${userId}:`, error.message);
    // @ts-ignore
    res.status(500).json({ message: "Erro interno ao buscar configurações da IA.", error: error.message });
  }
});

// Rota para salvar as configurações da IA
app.post('/api/ai/settings', clerkMiddleware({}), requireAuth(), async (req, res) => {
  console.log('\n[BACKEND LOG] ROTA POST /api/ai/settings ATINGIDA!\n');
  // @ts-ignore
  const { userId } = req.auth;
  if (!userId) {
    return res.status(401).json({ error: "Usuário não autenticado." });
  }

  const { ai_name, ai_style, ai_language } = req.body;

  if (!ai_name || !ai_language) { 
    return res.status(400).json({ message: "Nome da IA e Idioma são obrigatórios." });
  }

  try {
    const { data, error } = await supabase
      .from('aisettings')
      .upsert({ clerk_user_id: userId, ai_name, ai_style, ai_language, updated_at: new Date().toISOString() }, { onConflict: 'clerk_user_id' })
      .select()
      .single(); 

    if (error) {
      console.error(`[API /ai/settings POST] Erro ao salvar configurações da IA para ${userId}:`, error);
      throw error; 
    }
    
    console.log(`[API /ai/settings POST] Configurações da IA salvas com sucesso para ${userId}:`, data);
    res.status(200).json({ message: "Configurações da IA salvas com sucesso!", settings: data });
  } catch (error) {
    // @ts-ignore
    console.error(`[API /ai/settings POST] Catch final: Erro ao salvar configurações da IA para ${userId}:`, error.message);
    // @ts-ignore
    res.status(500).json({ message: "Erro interno ao salvar configurações da IA.", error: error.message });
  }
});

// ===== ROTAS DA BASE DE CONHECIMENTO =====

// Configuração do Multer para upload de arquivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB máximo
  },
  fileFilter: (req, file, cb) => {
    // Tipos de arquivo permitidos
    const allowedTypes = [
      'text/plain',
      'text/markdown',
      'application/pdf'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido. Use TXT, PDF, DOC, DOCX ou MD.'), false);
    }
  }
});

// POST /api/ai/knowledge-base - Upload de arquivo da base de conhecimento
app.post('/api/ai/knowledge-base', requireAuth(), upload.single('file'), async (req, res) => {
  try {
    const userId = req.auth.userId;
    
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo foi enviado' });
    }

    // Extrair texto do arquivo
    let extractedText = '';
    const fileBuffer = req.file.buffer;
    const fileType = req.file.mimetype;

    if (fileType === 'text/plain' || fileType === 'text/markdown') {
      extractedText = fileBuffer.toString('utf-8');
    } else if (fileType === 'application/pdf') {
      console.log('[Knowledge Base] PDF recebido. Extraindo texto...');
      try {
        // Extrair texto do PDF usando pdf-extraction
        const pdfData = await pdfExtract(fileBuffer);
        extractedText = pdfData.text;
        
        // Verificar se conseguimos extrair texto
        if (!extractedText || extractedText.trim().length === 0) {
          console.warn('[Knowledge Base] PDF sem texto extraível. Pode ser um PDF com imagens.');
          extractedText = `[Arquivo PDF: ${req.file.originalname}]\n\nEste PDF não contém texto extraível. Pode ser um arquivo com imagens ou texto digitalizado. Para melhor resultado da IA, considere converter este PDF para formato TXT ou MD com o texto em formato de texto plano.`;
        } else {
          console.log(`[Knowledge Base] Texto extraído do PDF com sucesso. ${extractedText.length} caracteres.`);
          // Adicionar metadados no início do texto extraído
          extractedText = `[Documento PDF: ${req.file.originalname}]\n\n${extractedText}`;
        }
      } catch (pdfError) {
        console.error('[Knowledge Base] Erro ao extrair texto do PDF:', pdfError);
        extractedText = `[Arquivo PDF: ${req.file.originalname}]\n\nErro ao processar o PDF. Para melhor resultado da IA, considere converter este PDF para formato TXT ou MD.`;
      }
    } else if (fileType === 'application/msword' || fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return res.status(400).json({ 
        error: 'Para melhor resultado, converta seu documento para arquivo TXT, MD ou PDF.' 
      });
    } else {
      return res.status(400).json({ 
        error: 'Tipo de arquivo não suportado. Use arquivos TXT, MD ou PDF.' 
      });
    }

    // Verificar se o texto foi extraído com sucesso
    if (!extractedText || extractedText.trim().length === 0) {
      return res.status(400).json({ 
        error: 'Não foi possível extrair texto do arquivo. Verifique se o arquivo contém texto válido.' 
      });
    }

    // Verificar se já existe uma base de conhecimento para este usuário
    const { data: existingKnowledge } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('user_id', userId)
      .single();

    let result;
    if (existingKnowledge) {
      // Atualizar base existente
      const { data, error } = await supabase
        .from('knowledge_base')
        .update({
          filename: req.file.originalname,
          content: extractedText,
          file_size: req.file.size,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      result = data;
    } else {
      // Criar nova base de conhecimento
      const { data, error } = await supabase
        .from('knowledge_base')
        .insert({
          user_id: userId,
          filename: req.file.originalname,
          content: extractedText,
          file_size: req.file.size,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;
      result = data;
    }

    res.json({
      success: true,
      message: 'Base de conhecimento atualizada com sucesso',
      id: result.id,
      filename: result.filename,
      fileSize: result.file_size
    });

  } catch (error) {
    console.error('Erro ao fazer upload da base de conhecimento:', error);
    
    // Melhor tratamento de erros
    let errorMessage = 'Erro interno do servidor ao processar upload';
    
    if (error.message) {
      if (error.message.includes('invalid input syntax for type uuid')) {
        errorMessage = 'Erro de autenticação. Tente fazer login novamente.';
      } else if (error.message.includes('duplicate key value')) {
        errorMessage = 'Você já possui uma base de conhecimento. O arquivo será substituído.';
      } else if (error.code === 'PGRST301') {
        errorMessage = 'Erro de permissão. Verifique se você está logado corretamente.';
      } else {
        errorMessage = 'Erro ao processar o arquivo. Verifique se o arquivo não está corrompido.';
      }
    }
    
    res.status(500).json({ 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/ai/knowledge-base - Buscar base de conhecimento do usuário
app.get('/api/ai/knowledge-base', requireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { data: knowledgeBase, error } = await supabase
      .from('knowledge_base')
      .select('id, filename, file_size, created_at, updated_at')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // Nenhuma base de conhecimento encontrada
        return res.json({ knowledgeBase: null });
      }
      throw error;
    }

    res.json({
      knowledgeBase: {
        id: knowledgeBase.id,
        filename: knowledgeBase.filename,
        fileSize: knowledgeBase.file_size,
        uploadedAt: knowledgeBase.updated_at || knowledgeBase.created_at,
        status: 'ready'
      }
    });

  } catch (error) {
    console.error('Erro ao buscar base de conhecimento:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor ao buscar base de conhecimento' 
    });
  }
});

// DELETE /api/ai/knowledge-base/:id - Remover base de conhecimento
app.delete('/api/ai/knowledge-base/:id', requireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;
    const knowledgeBaseId = req.params.id;

    console.log(`[DELETE Knowledge Base] Tentando remover base de conhecimento ID: ${knowledgeBaseId} para usuário: ${userId}`);

    // Verificar se a base de conhecimento pertence ao usuário
    const { data: knowledgeBase, error: fetchError } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('id', knowledgeBaseId)
      .eq('user_id', userId)
      .single();

    if (fetchError) {
      console.error('[DELETE Knowledge Base] Erro ao buscar base de conhecimento:', fetchError);
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Base de conhecimento não encontrada' });
      }
      throw fetchError;
    }

    console.log(`[DELETE Knowledge Base] Base de conhecimento encontrada:`, knowledgeBase);

    // Remover a base de conhecimento
    const { data: deleteResult, error: deleteError } = await supabase
      .from('knowledge_base')
      .delete()
      .eq('id', knowledgeBaseId)
      .eq('user_id', userId)
      .select();

    if (deleteError) {
      console.error('[DELETE Knowledge Base] Erro ao deletar:', deleteError);
      throw deleteError;
    }

    console.log(`[DELETE Knowledge Base] Base de conhecimento removida com sucesso:`, deleteResult);

    res.status(200).json({
      success: true,
      message: 'Base de conhecimento removida com sucesso'
    });

  } catch (error) {
    console.error('Erro ao remover base de conhecimento:', error);
    
    // Melhor tratamento de erros específicos
    let errorMessage = 'Erro interno do servidor ao remover base de conhecimento';
    let statusCode = 500;
    
    if (error.message) {
      if (error.message.includes('PGRST116')) {
        errorMessage = 'Base de conhecimento não encontrada';
        statusCode = 404;
      } else if (error.code === 'PGRST301') {
        errorMessage = 'Erro de permissão. Verifique se você tem autorização para remover esta base de conhecimento.';
        statusCode = 403;
      } else if (error.message.includes('RLS')) {
        errorMessage = 'Erro de permissão. Você só pode remover suas próprias bases de conhecimento.';
        statusCode = 403;
      }
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.listen(port, () => {
  console.log(`Servidor backend ESM rodando na porta ${port}`);
  const openaiApiKeyEncryptionKey = process.env.OPENAI_API_ENCRYPTION_KEY;
  if ((!openaiApiKeyEncryptionKey || openaiApiKeyEncryptionKey.length !== 64) && process.env.NODE_ENV !== 'test') {
    console.warn(`[Startup] AVISO: OPENAI_API_ENCRYPTION_KEY não está configurada corretamente no .env (deve ter 64 caracteres hexadecimais). A funcionalidade de salvar chaves da OpenAI não funcionará corretamente.`);
  }
});

// DASHBOARD ROUTES (dados reais)
app.use('/api/dashboard', requireAuth(), dashboardRoutes);

// STRIPE ROUTES
app.use('/api/stripe', stripeRouter);

// HELPDESK ROUTES
app.use('/api/helpdesk', helpdeskRouter);

// NOVA ROTA PARA ANALYTICS DE CONVERSÕES DA IA
app.get('/api/analytics/ai-conversions', requireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { period = 'today' } = req.query; // today, week, month
    
    let startDate, endDate = new Date();
    
    // Definir período
    switch (period) {
      case 'week':
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'month':
        startDate = new Date();
        startDate.setMonth(startDate.getMonth() - 1);
        break;
      default: // today
        startDate = new Date();
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
    }

    // Buscar conversões da IA
    const { data: conversions, error } = await supabase
      .from('ai_conversions')
      .select('*')
      .eq('clerk_user_id', userId)
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString())
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[Analytics] Erro ao buscar conversões da IA:', error);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }

    // Calcular estatísticas
    const totalSales = conversions?.reduce((sum, conv) => sum + (parseFloat(conv.sale_amount) || 0), 0) || 0;
    const totalOrders = conversions?.length || 0;
    const averageTicket = totalOrders > 0 ? totalSales / totalOrders : 0;

    // Agrupar vendas por hora para o gráfico
    const hourlyData = {};
    conversions?.forEach(conv => {
      const hour = new Date(conv.created_at).getHours();
      const hourKey = `${hour.toString().padStart(2, '0')}:00`;
      hourlyData[hourKey] = (hourlyData[hourKey] || 0) + parseFloat(conv.sale_amount || 0);
    });

    // Preencher horas vazias
    const fullHourlyData = [];
    for (let i = 0; i < 24; i++) {
      const hourKey = `${i.toString().padStart(2, '0')}:00`;
      fullHourlyData.push({
        hora: hourKey,
        vendas: Math.round(hourlyData[hourKey] || 0)
      });
    }

    res.json({
      totalSales: Math.round(totalSales * 100) / 100, // Arredondar para 2 casas decimais
      totalOrders,
      averageTicket: Math.round(averageTicket * 100) / 100,
      hourlyData: fullHourlyData,
      period
    });

  } catch (error) {
    console.error('[Analytics] Erro ao processar conversões da IA:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// NOVA ROTA PARA REGISTRAR CONVERSÕES DA IA
app.post('/api/analytics/ai-conversions', requireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { 
      trackingId, 
      saleAmount, 
      orderId, 
      customerPhone, 
      customerName,
      shopDomain,
      metadata = {} 
    } = req.body;

    if (!trackingId || !saleAmount) {
      return res.status(400).json({ error: 'trackingId e saleAmount são obrigatórios' });
    }

    // Verificar se já existe uma conversão com esse trackingId
    const { data: existingConversion } = await supabase
      .from('ai_conversions')
      .select('id')
      .eq('tracking_id', trackingId)
      .single();

    if (existingConversion) {
      return res.status(409).json({ error: 'Conversão já registrada para este tracking ID' });
    }

    // Registrar a conversão
    const { data: conversion, error } = await supabase
      .from('ai_conversions')
      .insert({
        user_id: userId,
        clerk_user_id: userId,
        tracking_id: trackingId,
        customer_phone: customerPhone,
        customer_name: customerName,
        sale_amount: parseFloat(saleAmount),
        order_id: orderId,
        shop_domain: shopDomain,
        conversion_source: 'whatsapp_ai',
        metadata: metadata
      })
      .select()
      .single();

    if (error) {
      console.error('[Analytics] Erro ao registrar conversão:', error);
      return res.status(500).json({ error: 'Erro ao registrar conversão' });
    }

    console.log(`✅ Conversão registrada: ${trackingId} - R$ ${saleAmount} - Pedido: ${orderId}`);
    res.json({ success: true, conversion });

  } catch (error) {
    console.error('[Analytics] Erro ao processar registro de conversão:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// WEBHOOK SHOPIFY PARA DETECTAR VENDAS VINDAS DA IA
app.post('/api/shopify/webhook/order-created', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const body = req.body;
    
    // Verificar se é um webhook válido do Shopify
    const crypto = require('crypto');
    const calculatedHmac = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
      .update(body, 'utf8')
      .digest('base64');
    
    if (calculatedHmac !== hmac) {
      console.log('❌ Webhook Shopify inválido - HMAC não confere');
      return res.status(401).send('Unauthorized');
    }

    const order = JSON.parse(body.toString());
    console.log(`📦 Novo pedido recebido: ${order.name} - ${order.total_price}`);

    // Verificar se o pedido veio de um link da IA (UTM parameters)
    const landingUrl = order.landing_site_ref || order.referring_site || '';
    const trackingMatch = landingUrl.match(/nuvemx_tracking=([^&]+)/);
    
    if (trackingMatch) {
      const trackingId = trackingMatch[1];
      console.log(`🎯 Pedido veio de link da IA! Tracking ID: ${trackingId}`);
      
      // Buscar o clerk_user_id baseado no domínio da loja
      const shopDomain = order.shop_domain || req.get('X-Shopify-Shop-Domain');
      
      if (shopDomain) {
        // Buscar na tabela shopify_sessions para encontrar o usuário
        const { data: session } = await supabase
          .from('shopify_sessions')
          .select('clerk_user_id')
          .eq('shop', shopDomain)
          .single();
        
        if (session?.clerk_user_id) {
          // Registrar a conversão automaticamente
          const conversionData = {
            user_id: session.clerk_user_id,
            clerk_user_id: session.clerk_user_id,
            tracking_id: trackingId,
            customer_phone: order.customer?.phone || null,
            customer_name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
            sale_amount: parseFloat(order.total_price),
            order_id: order.name,
            shop_domain: shopDomain,
            conversion_source: 'whatsapp_ai',
            metadata: {
              order_number: order.order_number,
              landing_url: landingUrl,
              utm_source: 'nuvemx_ai',
              utm_medium: 'whatsapp_assistant',
              customer_email: order.customer?.email,
              line_items: order.line_items?.map(item => ({
                name: item.name,
                quantity: item.quantity,
                price: item.price
              }))
            }
          };

          const { error } = await supabase
            .from('ai_conversions')
            .insert(conversionData);

          if (error) {
            console.error('❌ Erro ao registrar conversão automática:', error);
          } else {
            console.log(`✅ Conversão registrada automaticamente: ${trackingId} - R$ ${order.total_price}`);
          }
        }
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Erro ao processar webhook do Shopify:', error);
    res.status(500).send('Internal Server Error');
  }
});

// ROTAS DE INTERVENÇÃO HUMANA
app.post('/api/whatsapp/intervention/start', requireAuth(), async (req, res) => {
    try {
        const userId = req.auth.userId;
        const { instanceName, remoteJid, durationMinutes = 5 } = req.body;

        if (!instanceName || !remoteJid) {
            return res.status(400).json({ error: 'instanceName e remoteJid são obrigatórios' });
        }

        const result = await HumanInterventionService.startIntervention(userId, instanceName, remoteJid, durationMinutes);
        
        if (result.success) {
            res.json({ success: true, message: 'Intervenção iniciada com sucesso', data: result.data });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        console.error('Erro ao iniciar intervenção:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

app.post('/api/whatsapp/intervention/end', requireAuth(), async (req, res) => {
    try {
        const userId = req.auth.userId;
        const { instanceName, remoteJid } = req.body;

        if (!instanceName || !remoteJid) {
            return res.status(400).json({ error: 'instanceName e remoteJid são obrigatórios' });
        }

        const result = await HumanInterventionService.endIntervention(userId, instanceName, remoteJid);
        
        if (result.success) {
            res.json({ success: true, message: 'Intervenção finalizada com sucesso' });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        console.error('Erro ao finalizar intervenção:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

app.get('/api/whatsapp/intervention/status', requireAuth(), async (req, res) => {
    try {
        const userId = req.auth.userId;
        const { instanceName, remoteJid } = req.query;

        if (!instanceName || !remoteJid) {
            return res.status(400).json({ error: 'instanceName e remoteJid são obrigatórios' });
        }

        const result = await HumanInterventionService.checkActiveIntervention(userId, instanceName, remoteJid);
        res.json(result);
    } catch (error) {
        console.error('Erro ao verificar status da intervenção:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

app.get('/api/whatsapp/intervention/list', requireAuth(), async (req, res) => {
    try {
        const userId = req.auth.userId;
        const activeInterventions = await HumanInterventionService.listActiveInterventions(userId);
        res.json({ interventions: activeInterventions });
    } catch (error) {
        console.error('Erro ao listar intervenções:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// ROTA: Obter estatísticas do dashboard
app.get('/api/dashboard/stats', requireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;
    
    // Obter estatísticas de mensagens de hoje
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    
    // Contar mensagens do WhatsApp de hoje
    const { data: whatsappMessages, error: whatsappError } = await supabase
      .from('WhatsChatHistory')
      .select('id, timestamp')
      .eq('clerk_user_id', userId)
      .gte('timestamp', startOfDay.toISOString())
      .lt('timestamp', endOfDay.toISOString())
      .not('ai_response_content', 'is', null); // Apenas mensagens que a IA respondeu
    
    if (whatsappError) {
      console.error('Erro ao buscar mensagens WhatsApp:', whatsappError);
    }
    
    // Contar mensagens do playground de hoje
    const { data: playgroundMessages, error: playgroundError } = await supabase
      .from('PlaygroundChatHistory')
      .select('id, timestamp')
      .eq('clerk_user_id', userId)
      .gte('timestamp', startOfDay.toISOString())
      .lt('timestamp', endOfDay.toISOString())
      .not('ai_response', 'is', null); // Apenas mensagens que a IA respondeu
    
    if (playgroundError) {
      console.error('Erro ao buscar mensagens playground:', playgroundError);
    }
    
    // Calcular total de mensagens hoje
    const whatsappCount = whatsappMessages?.length || 0;
    const playgroundCount = playgroundMessages?.length || 0;
    const totalMessagesToday = whatsappCount + playgroundCount;
    
    // Buscar dados de mensagens por hora (últimas 24 horas)
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const { data: hourlyMessages, error: hourlyError } = await supabase
      .from('WhatsChatHistory')
      .select('timestamp')
      .eq('clerk_user_id', userId)
      .gte('timestamp', last24Hours.toISOString())
      .not('ai_response_content', 'is', null);
    
    if (hourlyError) {
      console.error('Erro ao buscar mensagens por hora:', hourlyError);
    }
    
    // Criar array de dados por hora
    const hourlyData = Array.from({ length: 24 }, (_, i) => {
      const hour = new Date();
      hour.setHours(hour.getHours() - (23 - i), 0, 0, 0);
      
      const hourStart = new Date(hour);
      const hourEnd = new Date(hour.getTime() + 60 * 60 * 1000);
      
      const messagesInHour = hourlyMessages?.filter(msg => {
        const msgTime = new Date(msg.timestamp);
        return msgTime >= hourStart && msgTime < hourEnd;
      }).length || 0;
      
      return {
        hour: hour.toTimeString().substring(0, 5), // HH:MM format
        messages: messagesInHour
      };
    });
    
    // Buscar informações de uso/limites
    const { data: subscriptionData, error: subscriptionError } = await supabase
      .from('user_subscriptions')
      .select('plan_type, monthly_message_limit, messages_used_current_month')
      .eq('clerk_user_id', userId)
      .single();
    
    let usageInfo = {
      planType: 'core',
      monthlyLimit: 500,
      messagesUsed: 0,
      usagePercentage: 0
    };
    
    if (!subscriptionError && subscriptionData) {
      usageInfo = {
        planType: subscriptionData.plan_type || 'core',
        monthlyLimit: subscriptionData.monthly_message_limit || 500,
        messagesUsed: subscriptionData.messages_used_current_month || 0,
        usagePercentage: Math.round(((subscriptionData.messages_used_current_month || 0) / (subscriptionData.monthly_message_limit || 500)) * 100)
      };
    }
    
    res.json({
      success: true,
      data: {
        messagesToday: totalMessagesToday,
        whatsappMessagesToday: whatsappCount,
        playgroundMessagesToday: playgroundCount,
        hourlyData,
        usage: usageInfo
      }
    });
    
  } catch (error) {
    console.error('Erro ao buscar estatísticas do dashboard:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor'
    });
  }
});

// Credenciais admin (carregadas do .env)
const ADMIN_CREDENTIALS = {
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
  secretKey: process.env.ADMIN_JWT_SECRET
};

// Validar se as credenciais admin estão configuradas
if (!ADMIN_CREDENTIALS.username || !ADMIN_CREDENTIALS.password || !ADMIN_CREDENTIALS.secretKey) {
  console.error('❌ [ADMIN CONFIG] Credenciais admin não configuradas no .env!');
  console.error('Configure: ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_JWT_SECRET');
  process.exit(1);
}

// Middleware de autenticação para rotas admin
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, error: 'Token de acesso admin necessário' });
  }

  try {
    const decoded = jwt.verify(token, ADMIN_CREDENTIALS.secretKey);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }
    req.admin = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Token inválido' });
  }
};

// Rota de login admin
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username e password são obrigatórios' });
    }

    // Verificar credenciais
    if (username !== ADMIN_CREDENTIALS.username) {
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    // Em produção, usar bcrypt.compare para senha hasheada
    const isValidPassword = password === ADMIN_CREDENTIALS.password;
    // const isValidPassword = await bcrypt.compare(password, ADMIN_CREDENTIALS.passwordHash);

    if (!isValidPassword) {
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    // Gerar JWT token
    const token = jwt.sign(
      { 
        username: username,
        role: 'admin',
        loginTime: Date.now()
      },
      ADMIN_CREDENTIALS.secretKey,
      { expiresIn: '8h' } // Token expira em 8 horas
    );

    res.json({
      success: true,
      token,
      expiresIn: '8h',
      message: 'Login admin realizado com sucesso'
    });

  } catch (error) {
    console.error('Erro no login admin:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// Rota para verificar se token admin é válido
app.get('/api/admin/verify', authenticateAdmin, (req, res) => {
  res.json({
    success: true,
    admin: {
      username: req.admin.username,
      loginTime: req.admin.loginTime
    },
    message: 'Token válido'
  });
});

// Admin routes - usar authenticateAdmin em vez de authenticateToken
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    // Verificar se usuário é admin
    const userRole = req.admin.role;
    if (userRole !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }

    // Buscar estatísticas administrativas
    const [usersResult, ticketsResult, revenueResult] = await Promise.all([
      supabase.from('profiles').select('id, created_at').order('created_at', { ascending: false }),
      supabase.from('helpdesk_tickets').select('id, status, created_at'),
      supabase.from('stripe_subscriptions').select('amount, status, created_at')
    ]);

    const totalUsers = usersResult.data?.length || 0;
    const activeUsers = usersResult.data?.filter(user => {
      const createdAt = new Date(user.created_at);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return createdAt >= thirtyDaysAgo;
    }).length || 0;

    const totalTickets = ticketsResult.data?.length || 0;
    const openTickets = ticketsResult.data?.filter(ticket => 
      ticket.status === 'open' || ticket.status === 'pending'
    ).length || 0;

    const totalRevenue = revenueResult.data?.reduce((sum, sub) => 
      sub.status === 'active' ? sum + (sub.amount || 0) : sum, 0
    ) || 0;

    const currentMonth = new Date().getMonth();
    const monthlyRevenue = revenueResult.data?.filter(sub => {
      const subMonth = new Date(sub.created_at).getMonth();
      return subMonth === currentMonth && sub.status === 'active';
    }).reduce((sum, sub) => sum + (sub.amount || 0), 0) || 0;

    const avgResponseTime = 15; // Mock - implementar cálculo real
    const conversionRate = 12.5; // Mock - implementar cálculo real

    res.json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        totalRevenue,
        monthlyRevenue,
        totalTickets,
        openTickets,
        avgResponseTime,
        conversionRate
      }
    });
  } catch (error) {
    console.error('Erro ao buscar stats admin:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

app.get('/api/admin/helpdesk-analysis', authenticateAdmin, async (req, res) => {
  try {
    // Verificar se usuário é admin
    const userRole = req.admin.role;
    if (userRole !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }

    // Buscar análise do helpdesk
    const { data: tickets } = await supabase
      .from('helpdesk_tickets')
      .select('category, status, created_at, resolved_at');

    // Analisar principais problemas
    const categoryCount = {};
    const statusCount = {};
    
    tickets?.forEach(ticket => {
      categoryCount[ticket.category] = (categoryCount[ticket.category] || 0) + 1;
      statusCount[ticket.status] = (statusCount[ticket.status] || 0) + 1;
    });

    const totalTickets = tickets?.length || 0;
    const topIssues = Object.entries(categoryCount)
      .map(([category, count]) => ({
        category,
        count,
        percentage: (count / totalTickets) * 100
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const ticketsByStatus = Object.entries(statusCount).map(([status, count]) => ({
      status,
      count,
      color: status === 'open' ? '#f59e0b' : 
             status === 'resolved' ? '#10b981' : 
             status === 'pending' ? '#6366f1' : '#64748b'
    }));

    const responseTimeMetrics = {
      avg: 15,
      min: 5,
      max: 120
    };

    res.json({
      success: true,
      data: {
        topIssues,
        ticketsByStatus,
        responseTimeMetrics
      }
    });
  } catch (error) {
    console.error('Erro ao buscar análise helpdesk:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

app.get('/api/admin/subscription-metrics', authenticateAdmin, async (req, res) => {
  try {
    // Verificar se usuário é admin
    const userRole = req.admin.role;
    if (userRole !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }

    // Buscar métricas de assinatura
    const { data: subscriptions } = await supabase
      .from('stripe_subscriptions')
      .select('plan_type, status, amount, created_at');

    const planCount = {};
    const planRevenue = {};
    
    subscriptions?.forEach(sub => {
      if (sub.status === 'active') {
        planCount[sub.plan_type] = (planCount[sub.plan_type] || 0) + 1;
        planRevenue[sub.plan_type] = (planRevenue[sub.plan_type] || 0) + sub.amount;
      }
    });

    const planDistribution = Object.entries(planCount).map(([plan, count]) => ({
      plan: plan === 'core' ? 'Core (Gratuito)' : 
            plan === 'neural' ? 'Neural (R$100)' : 
            plan === 'nimbus' ? 'Nimbus (R$200)' : plan,
      count,
      revenue: planRevenue[plan] || 0,
      color: plan === 'core' ? '#64748b' : 
             plan === 'neural' ? '#3b82f6' : 
             plan === 'nimbus' ? '#8b5cf6' : '#10b981'
    }));

    const churnRate = 2.5; // Mock - implementar cálculo real
    const growthRate = 15.8; // Mock - implementar cálculo real

    res.json({
      success: true,
      data: {
        planDistribution,
        churnRate,
        growthRate
      }
    });
  } catch (error) {
    console.error('Erro ao buscar métricas de assinatura:', error);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// ADMIN ROUTES (antes das outras rotas)
app.use('/api/admin', adminRoutes);