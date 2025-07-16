import { supabase } from './supabaseClient.js';
import subscriptionService from './subscriptionService.js';

// Tipos de ações rastreáveis
const ACTION_TYPES = {
  WHATSAPP_MESSAGE: 'whatsapp_message',
  AI_INTERACTION: 'ai_interaction', 
  PRODUCT_SYNC: 'product_sync',
  API_CALL: 'api_call'
};

const usageService = {
  /**
   * Busca o uso atual de mensagens de um usuário.
   * Usado principalmente pelas rotas de status de assinatura.
   * @param {string} clerkUserId - O ID do usuário no Clerk.
   * @returns {Promise<object>} - Um objeto com o detalhamento do uso.
   */
  async getCurrentUsage(clerkUserId) {
    try {
      // Esta função é um wrapper simplificado para o sistema de billing
      const subscription = await subscriptionService.getUserSubscription(clerkUserId);
      
      if (!subscription) {
        // Se não houver assinatura, o uso é zero.
        return {
          whatsapp_messages: 0,
          ai_interactions: 0,
          total_usage_cost: 0, // Placeholder para futuros custos por uso
        };
      }
      
      // No nosso modelo atual, o uso principal já está na tabela de assinaturas.
      // Podemos adicionar lógicas mais complexas aqui no futuro.
      return {
        whatsapp_messages: subscription.messages_used_current_month,
        ai_interactions: 0, // Placeholder para quando rastrearmos isso separadamente
        total_usage_cost: 0,
      };

    } catch (error) {
      console.error(`[UsageService] Erro ao buscar uso atual para ${clerkUserId}:`, error);
      // Retorna um objeto de uso zerado em caso de erro para não quebrar a API de status.
      return {
        whatsapp_messages: 0,
        ai_interactions: 0,
        total_usage_cost: 0,
      };
    }
  },

  /**
   * Verificar se usuário pode executar uma ação
   */
  async canPerformAction(clerkUserId, actionType, requestedCount = 1) {
    try {
      // Buscar assinatura do usuário
      const subscription = await subscriptionService.getUserSubscription(clerkUserId);
      
      if (!subscription) {
        // Usuário não inicializado - permitir e inicializar
        await subscriptionService.initializeUserSubscription(clerkUserId, 'temp@email.com');
        return { allowed: true, remaining: 500 - requestedCount };
      }

      // Verificar se precisa resetar o contador mensal
      await this.checkAndResetMonthlyUsage(clerkUserId);

      // Buscar uso atual
      const currentUsage = await this.getCurrentMonthUsage(clerkUserId, actionType);
      const limit = this.getActionLimit(subscription.plan_type, actionType);

      // Verificar se tem limite disponível
      const wouldExceed = (currentUsage + requestedCount) > limit;
      
      return {
        allowed: !wouldExceed,
        currentUsage,
        limit,
        remaining: Math.max(0, limit - currentUsage),
        wouldExceed,
        planType: subscription.plan_type
      };

    } catch (error) {
      console.error('❌ Erro ao verificar permissão de ação:', error.message);
      // Em caso de erro, permitir para não quebrar o fluxo
      return { allowed: true, error: error.message };
    }
  },

  /**
   * Registrar uso de uma ação
   */
  async trackUsage(clerkUserId, actionType, count = 1, metadata = {}) {
    try {
      // Verificar se pode executar
      const permission = await this.canPerformAction(clerkUserId, actionType, count);
      
      if (!permission.allowed) {
        throw new Error(`Limite de ${actionType} excedido. Atual: ${permission.currentUsage}/${permission.limit}`);
      }

      // Registrar o uso
      const { error: trackError } = await supabase
        .from('usage_tracking')
        .insert({
          clerk_user_id: clerkUserId,
          action_type: actionType,
          resource_count: count,
          metadata: metadata,
          timestamp: new Date().toISOString()
        });

      if (trackError) throw trackError;

      // Atualizar contador na tabela de assinaturas (para mensagens)
      if (actionType === ACTION_TYPES.WHATSAPP_MESSAGE) {
        await this.updateMonthlyMessageCount(clerkUserId, count);
      }

      console.log(`✅ Uso registrado: ${clerkUserId} - ${actionType} (${count})`);
      
      return {
        success: true,
        newUsage: permission.currentUsage + count,
        remaining: permission.remaining - count
      };

    } catch (error) {
      console.error('❌ Erro ao registrar uso:', error.message);
      throw error;
    }
  },

  /**
   * Buscar uso atual do mês para um tipo de ação
   */
  async getCurrentMonthUsage(clerkUserId, actionType) {
    try {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const { data, error } = await supabase
        .from('usage_tracking')
        .select('resource_count')
        .eq('clerk_user_id', clerkUserId)
        .eq('action_type', actionType)
        .gte('timestamp', startOfMonth.toISOString());

      if (error) throw error;

      const totalUsage = data?.reduce((sum, record) => sum + record.resource_count, 0) || 0;
      return totalUsage;

    } catch (error) {
      console.error('❌ Erro ao buscar uso atual:', error.message);
      return 0;
    }
  },

  /**
   * Buscar estatísticas detalhadas de uso
   */
  async getUsageStats(clerkUserId) {
    try {
      const subscription = await subscriptionService.getUserSubscription(clerkUserId);
      
      if (!subscription) {
        return { error: 'Usuário não encontrado' };
      }

      // Uso do mês atual
      const whatsappUsage = await this.getCurrentMonthUsage(clerkUserId, ACTION_TYPES.WHATSAPP_MESSAGE);
      const aiUsage = await this.getCurrentMonthUsage(clerkUserId, ACTION_TYPES.AI_INTERACTION);
      
      // Limites do plano
      const whatsappLimit = this.getActionLimit(subscription.plan_type, ACTION_TYPES.WHATSAPP_MESSAGE);
      const aiLimit = this.getActionLimit(subscription.plan_type, ACTION_TYPES.AI_INTERACTION);

      // Histórico dos últimos 7 dias
      const weeklyHistory = await this.getWeeklyUsageHistory(clerkUserId);

      return {
        planType: subscription.plan_type,
        planName: subscriptionService.getPlanInfo(subscription.plan_type).name,
        currentPeriod: {
          start: subscription.current_period_start,
          end: subscription.current_period_end
        },
        usage: {
          whatsapp: { current: whatsappUsage, limit: whatsappLimit, percentage: Math.round((whatsappUsage / whatsappLimit) * 100) },
          ai: { current: aiUsage, limit: aiLimit, percentage: Math.round((aiUsage / aiLimit) * 100) }
        },
        weeklyHistory
      };

    } catch (error) {
      console.error('❌ Erro ao buscar estatísticas:', error.message);
      throw error;
    }
  },

  /**
   * Buscar histórico de uso dos últimos 7 dias
   */
  async getWeeklyUsageHistory(clerkUserId) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const { data, error } = await supabase
        .from('usage_tracking')
        .select('action_type, resource_count, timestamp')
        .eq('clerk_user_id', clerkUserId)
        .gte('timestamp', sevenDaysAgo.toISOString())
        .order('timestamp', { ascending: true });

      if (error) throw error;

      // Agrupar por dia
      const dailyUsage = {};
      data?.forEach(record => {
        const day = record.timestamp.split('T')[0];
        if (!dailyUsage[day]) {
          dailyUsage[day] = { whatsapp: 0, ai: 0 };
        }
        
        if (record.action_type === ACTION_TYPES.WHATSAPP_MESSAGE) {
          dailyUsage[day].whatsapp += record.resource_count;
        } else if (record.action_type === ACTION_TYPES.AI_INTERACTION) {
          dailyUsage[day].ai += record.resource_count;
        }
      });

      return dailyUsage;

    } catch (error) {
      console.error('❌ Erro ao buscar histórico semanal:', error.message);
      return {};
    }
  },

  /**
   * Resetar contador mensal se necessário
   */
  async checkAndResetMonthlyUsage(clerkUserId) {
    try {
      const subscription = await subscriptionService.getUserSubscription(clerkUserId);
      
      if (!subscription || !subscription.last_usage_reset) {
        return;
      }

      const lastReset = new Date(subscription.last_usage_reset);
      const now = new Date();
      
      // Verificar se mudou o mês
      if (lastReset.getMonth() !== now.getMonth() || lastReset.getFullYear() !== now.getFullYear()) {
        await subscriptionService.updateSubscriptionByClerkId(clerkUserId, {
          messages_used_current_month: 0,
          last_usage_reset: now.toISOString().split('T')[0]
        });
        
        console.log(`✅ Contador mensal resetado para usuário ${clerkUserId}`);
      }

    } catch (error) {
      console.error('❌ Erro ao resetar contador mensal:', error.message);
    }
  },

  /**
   * Atualizar contador de mensagens mensais
   */
  async updateMonthlyMessageCount(clerkUserId, increment) {
    try {
      const { error } = await supabase.rpc('increment_message_count', {
        user_id: clerkUserId,
        increment_by: increment
      });

      if (error) {
        // Se a função RPC não existir, fazer update manual
        const subscription = await subscriptionService.getUserSubscription(clerkUserId);
        const newCount = (subscription?.messages_used_current_month || 0) + increment;
        
        await subscriptionService.updateSubscriptionByClerkId(clerkUserId, {
          messages_used_current_month: newCount
        });
      }

    } catch (error) {
      console.error('❌ Erro ao atualizar contador de mensagens:', error.message);
    }
  },

  /**
   * Obter limite de ação por plano
   */
  getActionLimit(planType, actionType) {
    const limits = {
      core: {
        [ACTION_TYPES.WHATSAPP_MESSAGE]: 500,
        [ACTION_TYPES.AI_INTERACTION]: 100,
        [ACTION_TYPES.PRODUCT_SYNC]: 50,
        [ACTION_TYPES.API_CALL]: 100
      },
      neural: {
        [ACTION_TYPES.WHATSAPP_MESSAGE]: 5000,
        [ACTION_TYPES.AI_INTERACTION]: 1000,
        [ACTION_TYPES.PRODUCT_SYNC]: 500,
        [ACTION_TYPES.API_CALL]: 1000
      },
      nimbus: {
        [ACTION_TYPES.WHATSAPP_MESSAGE]: 15000,
        [ACTION_TYPES.AI_INTERACTION]: 5000,
        [ACTION_TYPES.PRODUCT_SYNC]: 2000,
        [ACTION_TYPES.API_CALL]: 5000
      }
    };

    return limits[planType]?.[actionType] || 0;
  }
};

export { ACTION_TYPES };
export default usageService; 