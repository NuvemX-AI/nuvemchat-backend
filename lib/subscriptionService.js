import { supabase } from './supabaseClient.js';
import { stripe } from './stripeClient.js';

const PLANS = {
  core: { price_id: null, limit: 500, name: 'Core' },
  neural: { price_id: process.env.STRIPE_PRICE_NEURAL_ID, limit: 5000, name: 'Neural' },
  neural_annual: { price_id: process.env.STRIPE_PRICE_NEURAL_ANNUAL_ID, limit: 5000, name: 'Neural Anual' },
  nimbus: { price_id: process.env.STRIPE_PRICE_NIMBUS_ID, limit: 15000, name: 'Nimbus' },
  nimbus_annual: { price_id: process.env.STRIPE_PRICE_NIMBUS_ANNUAL_ID, limit: 15000, name: 'Nimbus Anual' }
};

const subscriptionService = {
  /**
   * Busca a assinatura atual de um usuário.
   * @param {string} clerkUserId - O ID do usuário no Clerk.
   * @returns {Promise<object|null>} - A assinatura do usuário ou null se não encontrada.
   */
  async getUserSubscription(clerkUserId) {
    const { data, error } = await supabase
      .from('user_subscriptions')
      .select('*')
      .eq('clerk_user_id', clerkUserId)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = 'No rows found'
      console.error(`[SubscriptionService] Erro ao buscar assinatura para ${clerkUserId}:`, error);
      throw error;
    }

    return data;
  },

  /**
   * Cria uma nova assinatura padrão (plano 'core') para um usuário.
   * @param {string} clerkUserId - O ID do usuário no Clerk.
   * @returns {Promise<object>} - A assinatura criada.
   */
  async createUserSubscription(clerkUserId) {
    console.log(`[SubscriptionService] Criando assinatura 'core' para o usuário ${clerkUserId}`);
    
    const { data, error } = await supabase
      .from('user_subscriptions')
      .insert([
        {
          clerk_user_id: clerkUserId,
          plan_type: 'core',
          status: 'active',
          monthly_message_limit: PLANS.core.limit,
          messages_used_current_month: 0,
          last_usage_reset: new Date().toISOString(),
        },
      ])
      .select()
      .single();

    if (error) {
      console.error(`[SubscriptionService] Erro ao criar assinatura para ${clerkUserId}:`, error);
      throw new Error('Erro ao criar assinatura do usuário no banco de dados.');
    }
    
    console.log(`[SubscriptionService] Assinatura 'core' criada com sucesso para ${clerkUserId}`);
    return data;
  },

  /**
   * Atualiza o ID do cliente Stripe para um usuário.
   * @param {string} clerkUserId - O ID do usuário no Clerk.
   * @param {string} stripeCustomerId - O ID do cliente no Stripe.
   */
  async updateStripeCustomerId(clerkUserId, stripeCustomerId) {
    const { error } = await supabase
      .from('user_subscriptions')
      .update({ stripe_customer_id: stripeCustomerId })
      .eq('clerk_user_id', clerkUserId);

    if (error) {
      console.error(`[SubscriptionService] Erro ao atualizar Stripe Customer ID para ${clerkUserId}:`, error);
      throw error;
    }
  },

  /**
   * Sincroniza a assinatura do banco de dados com os dados do Stripe.
   * @param {string} stripeSubscriptionId - O ID da assinatura no Stripe.
   * @param {object} updates - Os dados para atualizar.
   */
  async syncSubscriptionWithStripe(stripeSubscriptionId, updates) {
    const { error } = await supabase
      .from('user_subscriptions')
      .update(updates)
      .eq('stripe_subscription_id', stripeSubscriptionId);
      
    if (error) {
      console.error(`[SubscriptionService] Erro ao sincronizar assinatura ${stripeSubscriptionId}:`, error);
      throw error;
    }
  },
  
  /**
   * Atualiza a assinatura de um usuário com base no clerk_user_id.
   * @param {string} clerkUserId - O ID do usuário no Clerk.
   * @param {object} updates - Os dados para atualizar.
   */
  async updateSubscriptionByClerkId(clerkUserId, updates) {
    const { error } = await supabase
      .from('user_subscriptions')
      .update(updates)
      .eq('clerk_user_id', clerkUserId);

    if (error) {
      console.error(`[SubscriptionService] Erro ao atualizar assinatura para ${clerkUserId}:`, error);
      throw error;
    }
  },

  /**
   * Obter informações de um plano
   * @param {string} planType - Tipo do plano (core, neural, nimbus)
   * @returns {object} - Informações do plano
   */
  getPlanInfo(planType) {
    return PLANS[planType] || PLANS.core;
  }
};

export default subscriptionService; 