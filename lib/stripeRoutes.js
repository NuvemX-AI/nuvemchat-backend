import express from 'express';
import { requireAuth } from '@clerk/express';
import subscriptionService from './subscriptionService.js';
import usageService from './usageService.js';
import { stripe } from './stripeClient.js';

const router = express.Router();

// ================================
// ROTAS DE STATUS DE ASSINATURA
// ================================

/**
 * GET /api/stripe/subscription/status
 * Retorna status atual da assinatura do usuário
 */
router.get('/subscription/status', requireAuth(), async (req, res) => {
  try {
    const clerkUserId = req.auth.userId;
    
    let subscription = await subscriptionService.getUserSubscription(clerkUserId);
    
    if (!subscription) {
      console.log(`[Stripe Status] Assinatura não encontrada para ${clerkUserId}. Criando uma nova...`);
      await subscriptionService.createUserSubscription(clerkUserId);
      subscription = await subscriptionService.getUserSubscription(clerkUserId);

      if (!subscription) {
        return res.status(500).json({ error: 'Falha ao criar e buscar a assinatura padrão do usuário.' });
      }
    }
    
    // Buscar uso atual usando a nova função
    const currentUsage = await usageService.getCurrentUsage(clerkUserId);
    
    res.json({
      id: subscription.id,
      clerk_user_id: subscription.clerk_user_id,
      stripe_customer_id: subscription.stripe_customer_id,
      stripe_subscription_id: subscription.stripe_subscription_id,
      planType: subscription.plan_type,
      status: subscription.status,
      current_period_start: subscription.current_period_start,
      current_period_end: subscription.current_period_end,
      monthly_message_limit: subscription.monthly_message_limit,
      messages_used_current_month: subscription.messages_used_current_month,
      last_usage_reset: subscription.last_usage_reset,
      created_at: subscription.created_at,
      updated_at: subscription.updated_at,
      // Campos calculados para compatibilidade
      monthlyLimit: subscription.monthly_message_limit,
      currentUsage: subscription.messages_used_current_month,
      remaining: subscription.monthly_message_limit - subscription.messages_used_current_month,
      percentageUsed: Math.round((subscription.messages_used_current_month / subscription.monthly_message_limit) * 100),
      breakdown: currentUsage
    });
    
  } catch (error) {
    console.error('[Stripe Routes] Erro status:', error);
    res.status(500).json({ error: 'Erro ao buscar status da assinatura' });
  }
});

// ================================
// ROTAS DE CHECKOUT
// ================================

/**
 * POST /api/stripe/create-checkout-session
 * Cria sessão de checkout para upgrade de plano
 */
router.post('/create-checkout-session', requireAuth(), async (req, res) => {
  try {
    const clerkUserId = req.auth.userId;
    const { planType } = req.body;
    
    console.log(`[Stripe Checkout] Iniciando checkout para usuário ${clerkUserId} com plano ${planType}`);
    
    if (!planType || !['neural', 'nimbus', 'neural_annual', 'nimbus_annual'].includes(planType)) {
      console.log(`[Stripe Checkout] Plano inválido recebido: ${planType}`);
      return res.status(400).json({ error: 'Plano inválido' });
    }
    
    // Buscar ou criar customer Stripe
    let subscription = await subscriptionService.getUserSubscription(clerkUserId);
    
    if (!subscription) {
      // Primeira vez do usuário, criar assinatura básica
      console.log(`[Stripe Checkout] Criando assinatura básica para usuário ${clerkUserId}`);
      await subscriptionService.createUserSubscription(clerkUserId);
      subscription = await subscriptionService.getUserSubscription(clerkUserId);
    }
    
    let customerId = subscription.stripe_customer_id;
    
    if (!customerId) {
      // Criar customer no Stripe se não existir
      console.log(`[Stripe Checkout] Criando customer no Stripe para usuário ${clerkUserId}`);
      const customer = await stripe.customers.create({
        metadata: {
          clerk_user_id: clerkUserId
        }
      });
      
      customerId = customer.id;
      await subscriptionService.updateStripeCustomerId(clerkUserId, customerId);
    }
    
    // Determinar price_id baseado no plano (incluindo anuais)
    const priceIds = {
      neural: process.env.STRIPE_PRICE_NEURAL_ID,
      nimbus: process.env.STRIPE_PRICE_NIMBUS_ID,
      neural_annual: process.env.STRIPE_PRICE_NEURAL_ANNUAL_ID,
      nimbus_annual: process.env.STRIPE_PRICE_NIMBUS_ANNUAL_ID
    };
    
    const priceId = priceIds[planType];
    console.log(`[Stripe Checkout] Price ID para plano ${planType}: ${priceId}`);
    
    if (!priceId) {
      console.log(`[Stripe Checkout] Price ID não configurado para plano: ${planType}`);
      return res.status(400).json({ error: 'Price ID não configurado para este plano' });
    }
    
    // Criar session de checkout
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/dashboard?upgrade=success&plan=${planType}`,
      cancel_url: `${process.env.FRONTEND_URL}/planos?upgrade=canceled`,
      metadata: {
        clerk_user_id: clerkUserId,
        plan_type: planType
      },
      subscription_data: {
        metadata: {
          clerk_user_id: clerkUserId,
          plan_type: planType
        }
      }
    });
    
    console.log(`[Stripe Checkout] Sessão criada com sucesso: ${session.id}`);
    res.json({ url: session.url });
    
  } catch (error) {
    console.error('[Stripe Routes] Erro checkout:', error);
    res.status(500).json({ error: 'Erro ao criar sessão de checkout' });
  }
});

// ================================
// ROTAS DO PORTAL DO CLIENTE
// ================================

/**
 * POST /api/stripe/create-portal-session
 * Cria sessão do portal do cliente para gerenciar assinatura
 */
router.post('/create-portal-session', requireAuth(), async (req, res) => {
  try {
    const clerkUserId = req.auth.userId;
    
    const subscription = await subscriptionService.getUserSubscription(clerkUserId);
    if (!subscription || !subscription.stripe_customer_id) {
      return res.status(404).json({ error: 'Customer Stripe não encontrado' });
    }
    
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/dashboard`,
    });
    
    res.json({ url: portalSession.url });
    
  } catch (error) {
    console.error('[Stripe Routes] Erro portal:', error);
    res.status(500).json({ error: 'Erro ao criar portal' });
  }
});

/**
 * GET /api/stripe/invoices
 * Busca faturas do usuário no Stripe
 */
router.get('/invoices', requireAuth(), async (req, res) => {
  try {
    const clerkUserId = req.auth.userId;
    
    const subscription = await subscriptionService.getUserSubscription(clerkUserId);
    if (!subscription || !subscription.stripe_customer_id) {
      return res.json({ invoices: [] });
    }
    
    // Buscar faturas do customer no Stripe
    const invoices = await stripe.invoices.list({
      customer: subscription.stripe_customer_id,
      limit: 20, // Últimas 20 faturas
    });
    
    res.json({ 
      invoices: invoices.data.map(invoice => ({
        id: invoice.id,
        number: invoice.number,
        created: invoice.created,
        amount_paid: invoice.amount_paid,
        currency: invoice.currency,
        status: invoice.status,
        hosted_invoice_url: invoice.hosted_invoice_url
      }))
    });
    
  } catch (error) {
    console.error('[Stripe Routes] Erro ao buscar faturas:', error);
    res.status(500).json({ error: 'Erro ao buscar faturas' });
  }
});

// ================================
// ROTAS DE USO E ESTATÍSTICAS
// ================================

/**
 * GET /api/usage/current
 * Retorna uso atual do mês para o usuário
 */
router.get('/current', requireAuth(), async (req, res) => {
  try {
    const clerkUserId = req.auth.userId;
    
    const subscription = await subscriptionService.getUserSubscription(clerkUserId);
    if (!subscription) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const currentUsage = await usageService.getCurrentUsage(clerkUserId);
    
    res.json({
      planType: subscription.plan_type,
      monthly_message_limit: subscription.monthly_message_limit,
      messages_used_current_month: subscription.messages_used_current_month,
      // Campos calculados para compatibilidade
      monthlyLimit: subscription.monthly_message_limit,
      currentUsage: subscription.messages_used_current_month,
      remaining: subscription.monthly_message_limit - subscription.messages_used_current_month,
      percentageUsed: Math.round((subscription.messages_used_current_month / subscription.monthly_message_limit) * 100),
      breakdown: currentUsage
    });
    
  } catch (error) {
    console.error('[Stripe Routes] Erro uso atual:', error);
    res.status(500).json({ error: 'Erro ao buscar uso atual' });
  }
});

/**
 * GET /api/usage/stats  
 * Retorna estatísticas detalhadas de uso
 */
router.get('/stats', requireAuth(), async (req, res) => {
  try {
    const clerkUserId = req.auth.userId;
    const { days = 30 } = req.query;
    
    const stats = await usageService.getUsageStats(clerkUserId, parseInt(days));
    
    res.json(stats);
    
  } catch (error) {
    console.error('[Stripe Routes] Erro ao buscar estatísticas:', error);
    res.status(500).json({ 
      error: 'Erro interno ao buscar estatísticas' 
    });
  }
});

// ================================
// WEBHOOK DO STRIPE
// ================================

/**
 * POST /api/stripe/webhook
 * Processa eventos do Stripe
 */
router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('[Stripe Webhook] Erro de assinatura:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  
  console.log('[Stripe Webhook] Evento:', event.type);
  
  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionChange(event.data.object);
        break;
        
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
        
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
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
async function handleSubscriptionChange(subscription) {
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
    }
  }
  
  console.log(`[Webhook] Sincronizando subscription ${subscription.id}: plano ${planType}`);
  
  await subscriptionService.syncStripeSubscription(clerkUserId, {
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: subscription.customer,
    planType: planType,
    status: subscription.status,
    currentPeriodStart: new Date(subscription.current_period_start * 1000),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000)
  });
}

async function handleSubscriptionDeleted(subscription) {
  const clerkUserId = subscription.metadata?.clerk_user_id;
  
  if (!clerkUserId) {
    console.error('[Webhook] clerk_user_id ausente na subscription deleted:', subscription.id);
    return;
  }
  
  console.log(`[Webhook] Assinatura cancelada: ${subscription.id} para usuário ${clerkUserId}`);
  
  // Voltar para plano Core
  await subscriptionService.syncStripeSubscription(clerkUserId, {
    stripeSubscriptionId: null,
    stripeCustomerId: subscription.customer,
    planType: 'core',
    status: 'canceled',
    currentPeriodStart: null,
    currentPeriodEnd: null
  });
}

async function handlePaymentSucceeded(invoice) {
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

export default router; 