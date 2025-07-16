import { Router } from 'express';
import { supabase } from './supabaseClient.js';
import { redis } from './redisClient.js';

const router = Router();

// Cache de 5 minutos para estatísticas do dashboard
const DASHBOARD_CACHE_TTL = 300; // 5 minutos

// ROTA: Obter estatísticas do dashboard
router.get('/stats', async (req, res) => {
  try {
    const userId = req.auth.userId;
    
    // Verificar cache primeiro
    const cacheKey = `dashboard:stats:${userId}`;
    try {
      const cachedStats = await redis.get(cacheKey);
      if (cachedStats) {
        console.log(`[Dashboard Stats] ✅ Cache hit para usuário ${userId}`);
        return res.json({
          success: true,
          data: JSON.parse(cachedStats),
          cached: true
        });
      }
    } catch (cacheError) {
      console.warn('[Dashboard Stats] Erro ao acessar cache:', cacheError);
      // Continuar sem cache
    }
    
    // Obter estatísticas de mensagens de hoje (usando timezone do Brasil)
    const today = new Date();
    
    // Ajustar para timezone do Brasil (UTC-3)
    const brazilOffset = -3; // UTC-3
    const localToday = new Date(today.getTime() + (brazilOffset * 60 * 60 * 1000));
    
    const startOfDay = new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate());
    const endOfDay = new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate() + 1);
    
    // Converter de volta para UTC para a consulta
    const startOfDayUTC = new Date(startOfDay.getTime() - (brazilOffset * 60 * 60 * 1000));
    const endOfDayUTC = new Date(endOfDay.getTime() - (brazilOffset * 60 * 60 * 1000));
    
    console.log(`[Dashboard Stats] Buscando estatísticas para usuário ${userId}`);
    console.log(`[Dashboard Stats] Hoje (Brasil): ${localToday.toISOString()}`);
    console.log(`[Dashboard Stats] Período UTC: ${startOfDayUTC.toISOString()} até ${endOfDayUTC.toISOString()}`);
    
    // Contar mensagens do WhatsApp de hoje (apenas respostas da IA)
    const { data: whatsappMessages, error: whatsappError } = await supabase
      .from('WhatsChatHistory')
      .select('id, timestamp, ai_response_content')
      .eq('clerk_user_id', userId)
      .gte('timestamp', startOfDayUTC.toISOString())
      .lt('timestamp', endOfDayUTC.toISOString())
      .not('ai_response_content', 'is', null); // Apenas mensagens que a IA respondeu
    
    if (whatsappError) {
      console.error('[Dashboard Stats] Erro WhatsApp:', whatsappError);
    }
    
    // Contar mensagens do Playground de hoje (mensagens da IA)
    const { data: playgroundMessages, error: playgroundError } = await supabase
      .from('PlaygroundChatHistory')
      .select('id, timestamp, sender_type')
      .eq('clerk_user_id', userId)
      .eq('sender_type', 'ai') // Apenas respostas da IA
      .gte('timestamp', startOfDayUTC.toISOString())
      .lt('timestamp', endOfDayUTC.toISOString());
    
    if (playgroundError) {
      console.error('[Dashboard Stats] Erro Playground:', playgroundError);
    }
    
    // Obter uso do mês atual para billing (usando timezone do Brasil)
    const startOfMonth = new Date(localToday.getFullYear(), localToday.getMonth(), 1);
    const startOfMonthUTC = new Date(startOfMonth.getTime() - (brazilOffset * 60 * 60 * 1000));
    
    const { data: monthlyUsage, error: usageError } = await supabase
      .from('WhatsChatHistory')
      .select('id')
      .eq('clerk_user_id', userId)
      .gte('timestamp', startOfMonthUTC.toISOString())
      .not('ai_response_content', 'is', null);
    
    if (usageError) {
      console.error('[Dashboard Stats] Erro uso mensal:', usageError);
    }
    
    // Dados por hora simplificados (apenas últimas 6 horas para performance)
    const hourlyData = [];
    const currentHour = localToday.getHours(); // Usar hora local do Brasil
    
    for (let i = 5; i >= 0; i--) {
      const hourToCheck = currentHour - i;
      
      // Se a hora for negativa, pegar do dia anterior
      let hourStart, hourEnd;
      if (hourToCheck >= 0) {
        hourStart = new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate(), hourToCheck);
        hourEnd = new Date(localToday.getFullYear(), localToday.getMonth(), localToday.getDate(), hourToCheck + 1);
      } else {
        // Hora do dia anterior
        const yesterday = new Date(localToday);
        yesterday.setDate(yesterday.getDate() - 1);
        const actualHour = 24 + hourToCheck; // hourToCheck é negativo
        hourStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), actualHour);
        hourEnd = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), actualHour + 1);
      }
      
      // Converter para UTC para consulta
      const hourStartUTC = new Date(hourStart.getTime() - (brazilOffset * 60 * 60 * 1000));
      const hourEndUTC = new Date(hourEnd.getTime() - (brazilOffset * 60 * 60 * 1000));
      
      const { data: hourWhatsapp } = await supabase
        .from('WhatsChatHistory')
        .select('id')
        .eq('clerk_user_id', userId)
        .gte('timestamp', hourStartUTC.toISOString())
        .lt('timestamp', hourEndUTC.toISOString())
        .not('ai_response_content', 'is', null);
      
      const { data: hourPlayground } = await supabase
        .from('PlaygroundChatHistory')
        .select('id')
        .eq('clerk_user_id', userId)
        .eq('sender_type', 'ai')
        .gte('timestamp', hourStartUTC.toISOString())
        .lt('timestamp', hourEndUTC.toISOString());
      
      const displayHour = hourToCheck >= 0 ? hourToCheck : (24 + hourToCheck);
      
      hourlyData.push({
        hour: displayHour.toString().padStart(2, '0'), // Para mostrar "19" no tooltip
        whatsapp: hourWhatsapp ? hourWhatsapp.length : 0,
        playground: hourPlayground ? hourPlayground.length : 0,
        total: (hourWhatsapp ? hourWhatsapp.length : 0) + (hourPlayground ? hourPlayground.length : 0)
      });
    }
    
    const whatsappCount = whatsappMessages ? whatsappMessages.length : 0;
    const playgroundCount = playgroundMessages ? playgroundMessages.length : 0;
    const totalToday = whatsappCount + playgroundCount;
    const monthlyCount = monthlyUsage ? monthlyUsage.length : 0;
    
    const stats = {
      messagesToday: totalToday,
      whatsappMessagesToday: whatsappCount,
      playgroundMessagesToday: playgroundCount,
      hourlyData: hourlyData,
      usage: {
        planType: 'core',
        monthlyLimit: 500,
        messagesUsed: monthlyCount,
        usagePercentage: Math.round((monthlyCount / 500) * 100)
      },
      lastUpdated: new Date().toISOString()
    };
    
    // Salvar no cache
    try {
      await redis.setex(cacheKey, DASHBOARD_CACHE_TTL, JSON.stringify(stats));
      console.log(`[Dashboard Stats] ✅ Estatísticas salvas no cache para ${userId}`);
    } catch (cacheError) {
      console.warn('[Dashboard Stats] Erro ao salvar no cache:', cacheError);
    }
    
    console.log('[Dashboard Stats] Estatísticas calculadas:', stats);
    
    res.json({
      success: true,
      data: stats,
      cached: false
    });
    
  } catch (error) {
    console.error('[Dashboard Stats] Erro geral:', error);
    res.status(500).json({
      success: false,
      error: 'Erro interno do servidor',
      details: error.message
    });
  }
});

// ROTA: Invalidar cache (para desenvolvimento/testes)
router.delete('/cache/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const cacheKey = `dashboard:stats:${userId}`;
    
    await redis.del(cacheKey);
    console.log(`[Dashboard Cache] Cache invalidado para usuário ${userId}`);
    
    res.json({
      success: true,
      message: 'Cache invalidado com sucesso'
    });
  } catch (error) {
    console.error('[Dashboard Cache] Erro ao invalidar cache:', error);
    res.status(500).json({
      success: false,
      error: 'Erro ao invalidar cache'
    });
  }
});

export default router; 