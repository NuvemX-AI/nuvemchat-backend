import { redis } from './redisClient.js';

/**
 * Serviço de proteção contra loops de IA e situações problemáticas
 */
export class AILoopProtection {

  /**
   * Verifica se uma conversa é um grupo
   */
  static isGroupChat(remoteJid) {
    try {
      // Grupos no WhatsApp terminam com "@g.us"
      return remoteJid && remoteJid.endsWith('@g.us');
    } catch (error) {
      console.error('[AILoopProtection] Erro ao verificar grupo:', error);
      return false;
    }
  }

  /**
   * Detecta se a mensagem parece vir de outro bot/IA
   */
  static detectBotMessage(messageContent, pushName = '') {
    try {
      if (!messageContent) return false;

      const content = messageContent.toLowerCase();
      const name = (pushName || '').toLowerCase();

      // Padrões MUITO específicos que indicam claramente outro bot/IA
      const obviousBotPatterns = [
        // Comandos de bot óbvios
        /^\/\w+/,
        /^![\w]+/,
        
        // Mensagens de erro de sistema
        /erro interno|falha no sistema|sistema indisponível/i,
        /manutenção programada|serviço temporariamente indisponível/i,
        
        // Estruturas de menu muito específicas
        /^(digite|pressione) \d+ para/i,
        /^menu principal:/i,
        /^opções disponíveis:/i,
        
        // Respostas automáticas muito específicas
        /^mensagem automática:/i,
        /^resposta automática:/i,
        /^este é um bot/i,
        /^sou um bot/i,
        
        // Emojis de robô
        /🤖/
      ];

      // Nomes MUITO óbvios de bot (apenas casos extremamente claros)
      const obviousBotNames = [
        'chatbot', 'bot oficial', 'assistente virtual', 'sistema automático'
      ];

      // Verificar apenas padrões muito óbvios
      const hasObviousBotPattern = obviousBotPatterns.some(pattern => pattern.test(content));
      
      // Verificar apenas nomes muito óbvios
      const hasObviousBotName = obviousBotNames.some(botName => name.includes(botName));

      if (hasObviousBotPattern || hasObviousBotName) {
        console.log(`[AILoopProtection] Bot óbvio detectado: "${content.substring(0, 50)}..." / Nome: "${name}"`);
      }

      return hasObviousBotPattern || hasObviousBotName;

    } catch (error) {
      console.error('[AILoopProtection] Erro ao detectar bot:', error);
      return false;
    }
  }

  /**
   * Detecta conversas muito rápidas (possível loop)
   */
  static async detectRapidConversation(instanceName, remoteJid, threshold = 5, timeWindow = 60) {
    try {
      const key = `rapid_conv:${instanceName}:${remoteJid}`;
      const current = await redis.incr(key);
      
      if (current === 1) {
        // Primeiro incremento, definir expiração
        await redis.expire(key, timeWindow);
      }

      console.log(`[AILoopProtection] Conversa rápida detectada: ${current} mensagens em ${timeWindow}s para ${remoteJid}`);
      
      return current > threshold;
    } catch (error) {
      console.error('[AILoopProtection] Erro ao detectar conversa rápida:', error);
      return false;
    }
  }

  /**
   * Detecta padrões de mensagens idênticas (loop)
   */
  static async detectRepeatedMessages(instanceName, remoteJid, messageContent, maxRepeats = 3) {
    try {
      const key = `repeated_msg:${instanceName}:${remoteJid}`;
      const messageHash = this.hashMessage(messageContent);
      
      // Buscar últimas mensagens
      const lastMessages = await redis.lrange(key, 0, maxRepeats - 1);
      
      // Adicionar nova mensagem
      await redis.lpush(key, messageHash);
      await redis.ltrim(key, 0, maxRepeats - 1);
      await redis.expire(key, 300); // 5 minutos
      
      // Verificar se todas as últimas mensagens são iguais
      const allSame = lastMessages.length >= maxRepeats - 1 && 
                     lastMessages.every(hash => hash === messageHash);

      if (allSame) {
        console.log(`[AILoopProtection] Mensagens repetidas detectadas para ${remoteJid}: "${messageContent.substring(0, 50)}..."`);
      }

      return allSame;
    } catch (error) {
      console.error('[AILoopProtection] Erro ao detectar mensagens repetidas:', error);
      return false;
    }
  }

  /**
   * Gera hash simples de uma mensagem
   */
  static hashMessage(content) {
    if (!content) return '';
    
    // Normalizar e criar hash simples
    const normalized = content.toLowerCase()
                            .replace(/\s+/g, ' ')
                            .replace(/[^\w\s]/g, '')
                            .trim();
    
    // Hash simples baseado no conteúdo
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Converter para 32bit integer
    }
    
    return hash.toString();
  }

  /**
   * Detecta se o contato parece ser outro serviço automatizado
   */
  static detectAutomatedService(pushName = '', remoteJid = '') {
    try {
      const name = (pushName || '').toLowerCase();
      const jid = (remoteJid || '').toLowerCase();

      // Padrões de nomes automatizados - mais específicos para evitar falsos positivos
      const automatedPatterns = [
        // Serviços conhecidos
        /whatsapp.*business.*api/i,
        /business.*account.*api/i,
        /no.*reply/i,
        /noreply/i,
        /automated.*response/i,
        /automatic.*message/i,
        
        // Números de empresas muito específicos (evitar números normais)
        /^\+\d{12,}$/,  // Números muito longos
        /^\d{8,}.*\d{8,}$/,  // Padrões muito específicos
        
        // Prefixos de sistema muito específicos
        /^(admin|system|bot|auto|service)[\s\-_]/i,
        /^(api|webhook|notification)/i,
        /^(atendimento|suporte|vendas)[\s\-_]?(auto|bot|sistema)/i
      ];

      // Verificar se REALMENTE parece ser automatizado
      const isAutomated = automatedPatterns.some(pattern => 
        pattern.test(name) || pattern.test(jid)
      );

      if (isAutomated) {
        console.log(`[AILoopProtection] Serviço automatizado detectado: ${name} / ${jid}`);
      }

      return isAutomated;

    } catch (error) {
      console.error('[AILoopProtection] Erro ao detectar serviço automatizado:', error);
      return false;
    }
  }

  /**
   * Bloqueia temporariamente uma conversa por suspeita de loop
   */
  static async blockConversation(instanceName, remoteJid, durationMinutes = 30, reason = 'loop_detected') {
    try {
      const key = `blocked_conv:${instanceName}:${remoteJid}`;
      const blockData = {
        reason: reason,
        blockedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + (durationMinutes * 60 * 1000)).toISOString()
      };

      await redis.setex(key, durationMinutes * 60, JSON.stringify(blockData));
      
      console.log(`[AILoopProtection] Conversa bloqueada por ${durationMinutes} minutos: ${remoteJid} (Motivo: ${reason})`);
      
      return true;
    } catch (error) {
      console.error('[AILoopProtection] Erro ao bloquear conversa:', error);
      return false;
    }
  }

  /**
   * Verifica se uma conversa está bloqueada
   */
  static async isConversationBlocked(instanceName, remoteJid) {
    try {
      const key = `blocked_conv:${instanceName}:${remoteJid}`;
      const blockData = await redis.get(key);
      
      if (blockData) {
        const data = JSON.parse(blockData);
        console.log(`[AILoopProtection] Conversa bloqueada encontrada: ${remoteJid} (${data.reason})`);
        return { blocked: true, data: data };
      }
      
      return { blocked: false, data: null };
    } catch (error) {
      console.error('[AILoopProtection] Erro ao verificar bloqueio:', error);
      return { blocked: false, data: null };
    }
  }

  /**
   * Análise completa de proteção
   */
  static async analyzeConversation(instanceName, remoteJid, messageContent, pushName = '') {
    try {
      const analysis = {
        shouldBlock: false,
        reasons: [],
        blockDuration: 30 // minutos padrão
      };

      // 1. Verificar se é grupo (BLOQUEAR - IA não deve responder em grupos)
      if (this.isGroupChat(remoteJid)) {
        analysis.shouldBlock = true;
        analysis.reasons.push('group_chat');
        analysis.blockDuration = 60; // 1 hora para grupos
        return analysis; // Retornar imediatamente para grupos
      }

      // 2. Verificar se já está bloqueada
      const blockCheck = await this.isConversationBlocked(instanceName, remoteJid);
      if (blockCheck.blocked) {
        analysis.shouldBlock = true;
        analysis.reasons.push('already_blocked');
        return analysis;
      }

      // 3. Detectar bot/IA (BLOQUEAR - evitar loops entre IAs)
      if (this.detectBotMessage(messageContent, pushName)) {
        analysis.shouldBlock = true;
        analysis.reasons.push('bot_message');
        analysis.blockDuration = 120; // 2 horas para bots
      }

      // 4. Detectar serviço automatizado (BLOQUEAR - evitar responder para APIs)
      if (this.detectAutomatedService(pushName, remoteJid)) {
        analysis.shouldBlock = true;
        analysis.reasons.push('automated_service');
        analysis.blockDuration = 60;
      }

      // 5. Detectar mensagens repetidas (LOOP REAL - BLOQUEAR)
      const hasRepeated = await this.detectRepeatedMessages(instanceName, remoteJid, messageContent);
      if (hasRepeated) {
        analysis.shouldBlock = true;
        analysis.reasons.push('repeated_messages');
        analysis.blockDuration = 45;
      }

      // REMOVIDO: Detecção de conversa rápida (clientes podem enviar múltiplas mensagens)
      // Clientes normais devem poder enviar quantas mensagens quiserem

      return analysis;

    } catch (error) {
      console.error('[AILoopProtection] Erro na análise completa:', error);
      return {
        shouldBlock: false,
        reasons: ['analysis_error'],
        blockDuration: 0
      };
    }
  }

  /**
   * Limpa dados antigos de proteção
   */
  static async cleanup() {
    try {
      // Esta função pode ser expandida para limpeza mais específica
      console.log('[AILoopProtection] Limpeza de dados antigos executada');
    } catch (error) {
      console.error('[AILoopProtection] Erro na limpeza:', error);
    }
  }
} 