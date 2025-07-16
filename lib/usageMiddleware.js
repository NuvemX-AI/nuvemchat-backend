import usageService, { ACTION_TYPES } from './usageService.js';

/**
 * Middleware para verificar limite de uso antes de executar uma ação
 * @param {string} actionType - Tipo da ação (WHATSAPP_MESSAGE, AI_INTERACTION, etc.)
 * @param {number} count - Quantidade de recursos que serão consumidos
 * @param {object} options - Opções adicionais
 * @returns {function} Middleware do Express
 */
export function checkUsageLimit(actionType, count = 1, options = {}) {
  return async (req, res, next) => {
    try {
      // Verificar se usuário está autenticado
      const clerkUserId = req.auth?.userId;
      if (!clerkUserId) {
        return res.status(401).json({ 
          error: 'Usuário não autenticado',
          code: 'UNAUTHORIZED' 
        });
      }

      // Verificar limite de uso
      const permission = await usageService.canPerformAction(clerkUserId, actionType, count);
      
      if (!permission.allowed) {
        console.log(`[UsageMiddleware] Limite excedido para usuário ${clerkUserId}: ${permission.currentUsage}/${permission.limit}`);
        
        return res.status(429).json({
          error: 'Limite de uso excedido',
          code: 'USAGE_LIMIT_EXCEEDED',
          details: {
            currentUsage: permission.currentUsage,
            limit: permission.limit,
            planType: permission.planType,
            actionType: actionType,
            message: `Você já utilizou ${permission.currentUsage} de ${permission.limit} ${actionType} disponíveis no seu plano.`
          },
          upgradeRequired: true
        });
      }

      // Adicionar informações de uso ao request para uso posterior
      req.usageInfo = {
        permission,
        clerkUserId,
        actionType,
        requestedCount: count
      };

      console.log(`[UsageMiddleware] Limite OK para usuário ${clerkUserId}: ${permission.currentUsage}/${permission.limit} (${permission.remaining} restantes)`);
      next();

    } catch (error) {
      console.error('[UsageMiddleware] Erro ao verificar limite:', error);
      
      if (options.allowOnError) {
        // Em caso de erro, permitir continuar se especificado
        console.log('[UsageMiddleware] Permitindo continuar devido ao allowOnError=true');
        next();
      } else {
        res.status(500).json({
          error: 'Erro interno ao verificar limite de uso',
          code: 'USAGE_CHECK_ERROR'
        });
      }
    }
  };
}

/**
 * Middleware para rastrear uso após uma ação bem-sucedida
 * Deve ser usado APÓS o middleware de verificação
 * @param {object} metadata - Metadados adicionais para o tracking
 * @returns {function} Middleware do Express
 */
export function trackUsageAfter(metadata = {}) {
  return async (req, res, next) => {
    // Guardar o método original de envio da resposta
    const originalJson = res.json;
    const originalSend = res.send;

    // Interceptar o envio da resposta
    const trackUsage = async (statusCode) => {
      // Só rastrear se foi sucesso (2xx) e se temos informações de uso
      if (statusCode >= 200 && statusCode < 300 && req.usageInfo) {
        try {
          const { clerkUserId, actionType, requestedCount } = req.usageInfo;
          
          const usageResult = await usageService.trackUsage(
            clerkUserId,
            actionType,
            requestedCount,
            {
              ...metadata,
              route: req.route?.path || req.path,
              method: req.method,
              userAgent: req.get('User-Agent'),
              timestamp: new Date().toISOString()
            }
          );

          console.log(`[UsageMiddleware] Uso registrado para ${clerkUserId}: ${usageResult.newUsage} (${usageResult.remaining} restantes)`);
        } catch (trackError) {
          console.error('[UsageMiddleware] Erro ao registrar uso:', trackError);
        }
      }
    };

    // Sobrescrever res.json
    res.json = function(...args) {
      trackUsage(this.statusCode);
      return originalJson.apply(this, args);
    };

    // Sobrescrever res.send
    res.send = function(...args) {
      trackUsage(this.statusCode);
      return originalSend.apply(this, args);
    };

    next();
  };
}

/**
 * Middleware combinado que verifica e rastreia uso
 * @param {string} actionType - Tipo da ação
 * @param {number} count - Quantidade de recursos
 * @param {object} options - Opções para verificação e metadados para tracking
 * @returns {function} Middleware do Express
 */
export function checkAndTrackUsage(actionType, count = 1, options = {}) {
  const { trackMetadata = {}, ...checkOptions } = options;
  
  return [
    checkUsageLimit(actionType, count, checkOptions),
    trackUsageAfter(trackMetadata)
  ];
}

// Middlewares pré-configurados para ações comuns
export const middlewares = {
  // Para interações com IA (playground, chat, etc.)
  aiInteraction: (options = {}) => checkAndTrackUsage(ACTION_TYPES.AI_INTERACTION, 1, {
    ...options,
    trackMetadata: { type: 'ai_interaction', ...options.trackMetadata }
  }),

  // Para sincronização de produtos Shopify
  productSync: (count = 1, options = {}) => checkAndTrackUsage(ACTION_TYPES.PRODUCT_SYNC, count, {
    ...options,
    trackMetadata: { type: 'product_sync', count, ...options.trackMetadata }
  }),

  // Para chamadas de API externas
  apiCall: (options = {}) => checkAndTrackUsage(ACTION_TYPES.API_CALL, 1, {
    ...options,
    trackMetadata: { type: 'api_call', ...options.trackMetadata }
  })
};

export default {
  checkUsageLimit,
  trackUsageAfter, 
  checkAndTrackUsage,
  middlewares
}; 