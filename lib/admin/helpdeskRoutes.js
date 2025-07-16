import express from 'express';
import { requireAuth } from '@clerk/express';
import helpdeskService from './helpdeskService.js';
import { redis } from '../redisClient.js'; // Corrigido: importar do redisClient.js

const router = express.Router();

// Middleware de autenticação apenas para rotas específicas (não todas)
// router.use(requireAuth());

// Iniciar sessão de suporte
router.post('/session/start', requireAuth(), async (req, res) => {
  try {
    const clerkUserId = req.auth.userId;
    
    if (!clerkUserId) {
      return res.status(401).json({
        success: false,
        error: 'Usuário não autenticado'
      });
    }

    const result = await helpdeskService.createSession(clerkUserId);
    res.json(result);
  } catch (error) {
    console.error('Erro ao iniciar sessão:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor'
    });
  }
});

// Chat com IA de suporte
router.post('/chat', requireAuth(), async (req, res) => {
  try {
    const clerkUserId = req.auth.userId;
    const { message, sessionId } = req.body;

    if (!clerkUserId) {
      return res.status(401).json({
        success: false,
        error: 'Usuário não autenticado'
      });
    }
    
    // Verificar se o usuário tem perfil, senão criar um básico
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', clerkUserId)
      .single();
    
    if (!existingProfile) {
      console.log('👤 Criando perfil básico para usuário do helpdesk:', clerkUserId);
      
      // Obter dados básicos do Clerk
      const userInfo = req.auth.sessionClaims;
      console.log('🔍 Debug - sessionClaims:', userInfo);
      
      const email = userInfo?.email || userInfo?.primaryEmailAddress || null;
      const firstName = userInfo?.firstName || userInfo?.first_name || userInfo?.given_name || '';
      const lastName = userInfo?.lastName || userInfo?.last_name || userInfo?.family_name || '';
      const fullName = firstName && lastName ? `${firstName} ${lastName}` : 
                      firstName || userInfo?.username || email?.split('@')[0] || 'Usuário Helpdesk';
      
      const { error: insertError } = await supabase
        .from('profiles')
        .insert({
          id: clerkUserId,
          email: email,
          full_name: fullName,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      
      if (insertError) {
        console.error('Erro ao criar perfil básico:', insertError);
      } else {
        console.log('✅ Perfil básico criado com sucesso');
      }
    }

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Mensagem é obrigatória'
      });
    }

    // Se não há sessionId, processamos como chat normal (sem sessão)
    const result = await helpdeskService.processMessage(sessionId, message, clerkUserId);
    res.json(result);
  } catch (error) {
    console.error('Erro no chat:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor'
    });
  }
});

// Buscar na base de conhecimento (sem autenticação)
router.get('/knowledge-base/search', async (req, res) => {
  try {
    const { q: query, limit = 5 } = req.query;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query é obrigatória'
      });
    }

    const result = await helpdeskService.searchKnowledgeBase(query, parseInt(limit));
    res.json(result);
  } catch (error) {
    console.error('Erro na busca:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor'
    });
  }
});

// NOVO: Rota para monitorar status do debounce do Alex (Admin only)
router.get('/alex/status', async (req, res) => {
  try {
    const stats = helpdeskService.getDebounceStats();
    res.json({
      success: true,
      debounce: {
        enabled: true,
        debounceTime: 3000, // ms
        maxAccumulatedLength: 1000,
        ...stats
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro ao buscar status do Alex:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor'
    });
  }
});

// NOVO: Rota para limpar timers do debounce (Admin only)
router.post('/alex/clear-timers', async (req, res) => {
  try {
    helpdeskService.clearActiveTimers();
    res.json({
      success: true,
      message: 'Timers de debounce limpos com sucesso'
    });
  } catch (error) {
    console.error('Erro ao limpar timers:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor'
    });
  }
});

// Limpar histórico Redis (para nova conversa)
router.post('/clear-history', requireAuth(), async (req, res) => {
  try {
    const clerkUserId = req.auth.userId;
    const { historyKey } = req.body;

    if (!clerkUserId) {
      return res.status(401).json({
        success: false,
        error: 'Usuário não autenticado'
      });
    }

    // Limpar histórico específico ou geral do usuário
    const keyToDelete = historyKey || `alex_history:${clerkUserId}`;
    
    await redis.del(keyToDelete);
    console.log(`[Alex History] Histórico limpo para: ${keyToDelete}`);

    res.json({
      success: true,
      message: 'Histórico limpo com sucesso'
    });
  } catch (error) {
    console.error('Erro ao limpar histórico:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor'
    });
  }
});

export default router; 