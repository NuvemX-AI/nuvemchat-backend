import OpenAI from 'openai';
import { supabase } from '../supabaseClient.js';
import { ALEX_SYSTEM_PROMPT, ALEX_FALLBACK_MESSAGE } from './alexPrompt.js';
import { decrypt } from '../utils.js'; // Import decrypt function
import { redis } from '../redisClient.js'; // NOVO: Importar Redis para debounce

// NOVO: Configurações de debounce para Alex
const ALEX_DEBOUNCE_TIME_MS = 3000; // 3 segundos para Alex "pensar"
const ALEX_MAX_ACCUMULATED_LENGTH = 1000; // Limite de caracteres acumulados
const activeAlexDebounceTimers = {}; // Timers ativos por sessão

class HelpdeskService {
  constructor() {
    // Usar o prompt importado
    this.systemPrompt = ALEX_SYSTEM_PROMPT;
    
    // NOVO: Limpar timers ativos na inicialização
    this.clearActiveTimers();
  }

  // NOVO: Função para limpar timers ativos
  clearActiveTimers() {
    console.log('[Alex Debounce] Limpando timers ativos na inicialização...');
    Object.keys(activeAlexDebounceTimers).forEach(key => {
      clearTimeout(activeAlexDebounceTimers[key]);
      delete activeAlexDebounceTimers[key];
    });
    console.log('[Alex Debounce] Timers limpos com sucesso.');
  }

  // NOVO: Função para obter estatísticas de debounce
  getDebounceStats() {
    const activeTimers = Object.keys(activeAlexDebounceTimers).length;
    return {
      activeTimers,
      timers: Object.keys(activeAlexDebounceTimers)
    };
  }

  async createSession(clerkUserId) {
    try {
      const { data, error } = await supabase
        .from('helpdesk_sessions')
        .insert([
          {
            clerk_user_id: clerkUserId,
            status: 'active',
            created_at: new Date().toISOString()
          }
        ])
        .select()
        .single();

      if (error) throw error;

      return {
        success: true,
        sessionId: data.id
      };
    } catch (error) {
      console.error('Erro ao criar sessão:', error);
      return {
        success: false,
        error: 'Erro ao iniciar sessão de suporte'
      };
    }
  }

  async processMessage(sessionId, message, clerkUserId) {
    try {
      // NOVO: Implementar debounce para Alex
      return await this.processMessageWithDebounce(sessionId, message, clerkUserId);

    } catch (error) {
      console.error('Erro ao processar mensagem:', error);
      return {
        success: false,
        error: 'Erro ao processar sua mensagem. Tente novamente.'
      };
    }
  }

  // NOVO: Função de debounce para Alex
  async processMessageWithDebounce(sessionId, message, clerkUserId) {
    const debounceKey = `alex_debounce:${sessionId}:${clerkUserId}`;
    const accumulatedKey = `alex_accumulated:${sessionId}:${clerkUserId}`;
    
    try {
      console.log(`[Alex Debounce] Iniciando debounce para sessão ${sessionId}`);

      // Cancelar timer anterior se existir
      if (activeAlexDebounceTimers[debounceKey]) {
        console.log(`[Alex Debounce] Cancelando timer anterior para ${sessionId}`);
        clearTimeout(activeAlexDebounceTimers[debounceKey]);
        delete activeAlexDebounceTimers[debounceKey];
      }

      // Acumular mensagem no Redis
      const existingMessages = await redis.get(accumulatedKey) || '';
      const newAccumulated = existingMessages ? `${existingMessages}\n${message}` : message;
      
      // Verificar limite de caracteres
      const finalMessage = newAccumulated.length > ALEX_MAX_ACCUMULATED_LENGTH 
        ? newAccumulated.substring(newAccumulated.length - ALEX_MAX_ACCUMULATED_LENGTH)
        : newAccumulated;

      await redis.setex(accumulatedKey, 300, finalMessage); // 5 minutos de TTL

      console.log(`[Alex Debounce] Mensagem acumulada (${finalMessage.length} chars): "${finalMessage.substring(0, 100)}..."`);

      // Criar novo timer de debounce e aguardar a resposta final
      return new Promise((resolve) => {
        activeAlexDebounceTimers[debounceKey] = setTimeout(async () => {
          try {
            console.log(`[Alex Debounce] Processando mensagem final para sessão ${sessionId}`);
            
            // Buscar mensagem acumulada final
            const finalAccumulatedMessage = await redis.get(accumulatedKey) || finalMessage;
            
            // Limpar dados de debounce
            await redis.del(accumulatedKey);
            delete activeAlexDebounceTimers[debounceKey];

            // Processar mensagem final
            const result = await this.processAlexMessage(sessionId, finalAccumulatedMessage, clerkUserId);
            resolve(result);

          } catch (error) {
            console.error(`[Alex Debounce] Erro ao processar mensagem final:`, error);
            resolve({
              success: false,
              error: 'Erro ao processar sua mensagem após debounce. Tente novamente.'
            });
          }
        }, ALEX_DEBOUNCE_TIME_MS);

        console.log(`[Alex Debounce] Timer criado para sessão ${sessionId}, aguardando ${ALEX_DEBOUNCE_TIME_MS}ms`);
      });

    } catch (error) {
      console.error(`[Alex Debounce] Erro no debounce:`, error);
      // Fallback: processar imediatamente sem debounce
      return await this.processAlexMessage(sessionId, message, clerkUserId);
    }
  }

  // NOVO: Função principal de processamento do Alex (após debounce)
  async processAlexMessage(sessionId, message, clerkUserId) {
    try {
      console.log(`[Alex AI] Processando mensagem final: "${message.substring(0, 100)}..."`);

      // Fetch and decrypt OpenAI key from Supabase
      const { data: keyData, error: keyError } = await supabase
        .from('OpenAIKeys')
        .select('encrypted_api_key')
        .eq('clerk_user_id', clerkUserId)
        .single();

      if (keyError || !keyData || !keyData.encrypted_api_key) {
        console.warn('⚠️ No OpenAI key found for user. Using fallback.');
        return {
          success: true,
          response: ALEX_FALLBACK_MESSAGE,
          shouldEscalate: true
        };
      }

      const decryptedApiKey = decrypt(keyData.encrypted_api_key);
      if (!decryptedApiKey) {
        throw new Error('Failed to decrypt OpenAI API key.');
      }

      const openai = new OpenAI({ apiKey: decryptedApiKey });

      // NOVO: Buscar histórico de conversas mesmo sem sessionId (usando Redis)
      let conversationHistory = [];
      
      if (sessionId) {
      // Buscar contexto da sessão
      const sessionData = await this.getSessionContext(sessionId, clerkUserId);
      if (!sessionData.success) {
        return sessionData;
      }

        // Buscar histórico de conversas do banco
        conversationHistory = await this.getConversationHistory(sessionId);
      } else {
        // NOVO: Buscar histórico do Redis para conversas sem sessão
        const historyKey = `alex_history:${clerkUserId}`;
        const historyData = await redis.get(historyKey);
        
        if (historyData) {
          try {
            const parsedHistory = JSON.parse(historyData);
            conversationHistory = parsedHistory.slice(-10); // Últimas 10 mensagens
            console.log(`[Alex AI] Histórico do Redis carregado: ${conversationHistory.length} mensagens`);
          } catch (parseError) {
            console.error('[Alex AI] Erro ao fazer parse do histórico do Redis:', parseError);
          }
        }
      }

      // Construir mensagens para OpenAI
      const messages = [
        { role: 'system', content: ALEX_SYSTEM_PROMPT },
        ...conversationHistory,
        { role: 'user', content: message }
      ];

      console.log('[Alex AI] Enviando para OpenAI:', JSON.stringify(messages, null, 2));

      // Chamar OpenAI
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages,
        temperature: 0.7,
        max_tokens: 1000,
        response_format: { type: "json_object" }
      });

      const aiContent = completion.choices[0].message.content;

      if (!aiContent) {
        throw new Error('Resposta vazia da OpenAI');
      }

      console.log('[Alex AI] Resposta bruta da OpenAI:', aiContent);

      // Parse da resposta JSON
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(aiContent);
      } catch (parseError) {
        console.error('[Alex AI] Erro ao fazer parse da resposta JSON:', parseError);
        console.error('[Alex AI] Resposta original:', aiContent);
        
        // Fallback: usar resposta como texto simples
        parsedResponse = {
          response: aiContent,
          escalate: false,
          ticket_title: '',
          ticket_description: ''
        };
      }

      const aiResponse = parsedResponse.response;
      const shouldEscalate = parsedResponse.escalate || false;
      const ticketTitle = parsedResponse.ticket_title;
      const ticketDesc = parsedResponse.ticket_description;

      console.log('[Alex AI] Resposta processada:', parsedResponse);

      // NOVO: Salvar histórico no Redis para conversas sem sessão
      if (!sessionId) {
        const historyKey = `alex_history:${clerkUserId}`;
        const newHistory = [
          ...conversationHistory,
          { role: 'user', content: message },
          { role: 'assistant', content: aiResponse }
        ].slice(-20); // Manter apenas últimas 20 mensagens
        
        await redis.setex(historyKey, 3600, JSON.stringify(newHistory)); // 1 hora de TTL
        console.log(`[Alex AI] Histórico salvo no Redis: ${newHistory.length} mensagens`);
      }

      // Salvar conversa apenas se há sessionId
      if (sessionId) {
        await this.saveConversation(sessionId, message, aiResponse, shouldEscalate, clerkUserId);
      }

      // NOVO: Criar ticket mesmo sem sessionId se necessário
      if (shouldEscalate && ticketTitle && ticketDesc) {
        console.log('[Alex AI] Escalando para ticket:', ticketTitle);
        
        // Se não há sessionId, criar uma sessão temporária
        let ticketSessionId = sessionId;
        if (!ticketSessionId) {
          const sessionResult = await this.createSession(clerkUserId);
          if (sessionResult.success) {
            ticketSessionId = sessionResult.sessionId;
            console.log('[Alex AI] Sessão temporária criada para ticket:', ticketSessionId);
          }
        }
        
        if (ticketSessionId) {
          await this.createTicket(ticketSessionId, clerkUserId, ticketTitle, ticketDesc, aiResponse);
        }
      }

      return {
        success: true,
        response: aiResponse,
        shouldEscalate: shouldEscalate,
        ticketTitle: ticketTitle,
        ticketDescription: ticketDesc
      };

    } catch (error) {
      console.error('Erro ao processar mensagem do Alex:', error);
      return {
        success: false,
        error: 'Erro ao processar sua mensagem. Tente novamente.'
      };
    }
  }

  async getSessionContext(sessionId, clerkUserId) {
    try {
      const { data, error } = await supabase
        .from('helpdesk_sessions')
        .select('*')
        .eq('id', sessionId)
        .eq('clerk_user_id', clerkUserId)
        .single();

      if (error) throw error;

      return {
        success: true,
        session: data
      };
    } catch (error) {
      console.error('Erro ao buscar contexto da sessão:', error);
      return {
        success: false,
        error: 'Sessão não encontrada'
      };
    }
  }

  async getConversationHistory(sessionId, limit = 10) {
    try {
      const { data, error } = await supabase
        .from('helpdesk_conversations')
        .select('message_type, message, created_at')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .limit(limit * 2); // Multiplicar por 2 para pegar pares user/ai

      if (error) throw error;

      // Converter para formato OpenAI
      const messages = (data || []).map(conv => ({
        role: conv.message_type === 'user' ? 'user' : 'assistant',
        content: conv.message
      }));

      console.log(`[Alex AI] Histórico carregado: ${messages.length} mensagens`);
      console.log(`[Alex AI] Mensagens do histórico:`, messages.map(m => `${m.role}: ${m.content.substring(0, 50)}...`));

      return messages;

    } catch (error) {
      console.error('Erro ao buscar histórico de conversa:', error);
      return [];
    }
  }

  async saveConversation(sessionId, userMessage, aiResponse, shouldEscalate, clerkUserId) {
    try {
      // Salvar mensagem do usuário
      const { error: userError } = await supabase
        .from('helpdesk_conversations')
        .insert([
          {
            session_id: sessionId,
            message_type: 'user',
            message: userMessage,
            clerk_user_id: clerkUserId,
            created_at: new Date().toISOString()
          }
        ]);

      if (userError) throw userError;

      // Salvar resposta da IA
      const { error: aiError } = await supabase
        .from('helpdesk_conversations')
        .insert([
          {
            session_id: sessionId,
            message_type: 'ai',
            message: aiResponse,
            clerk_user_id: clerkUserId,
            metadata: { escalated: shouldEscalate },
            created_at: new Date().toISOString()
          }
        ]);

      if (aiError) throw aiError;
    } catch (error) {
      console.error('Erro ao salvar conversa:', error);
    }
  }

  shouldEscalateToHuman(userMessage, aiResponse) {
    // Nível 1: Verificação básica de palavras-chave (Executive Level)
    const escalationKeywords = [
      'reembolso', 'refund', 'cancelar assinatura', 'cancel subscription',
      'não funciona', 'not working', 'bug', 'erro crítico', 'critical error',
      'falar com humano', 'talk to human', 'suporte técnico', 'technical support',
      'problema de pagamento', 'payment issue', 'cobrança incorreta', 'wrong charge',
      'abre um ticket', 'crie um ticket', 'criar ticket', 'open a ticket', 'create ticket'
    ];

    const userMessageLower = userMessage.toLowerCase();
    const keywordScore = escalationKeywords.reduce((score, keyword) => 
      userMessageLower.includes(keyword.toLowerCase()) ? score + 1 : score, 0);

    // Nível 2: Análise de complexidade e incerteza (Tactical Level)
    const complexityScore = this.assessComplexity(userMessage);
    const uncertaintyScore = this.assessUncertainty(aiResponse);

    // Nível 3: Decisão baseada em thresholds (Operational Level)
    const totalScore = keywordScore * 2 + complexityScore + uncertaintyScore;
    const escalationThreshold = 3; // Ajuste conforme necessário

    // Verificação: Também escalar se a IA indicar explicitamente
    const aiIndicatesEscalation = aiResponse.toLowerCase().includes('não posso') ||
                                  aiResponse.toLowerCase().includes('precisa falar') ||
                                  aiResponse.toLowerCase().includes('suporte técnico');

    return totalScore >= escalationThreshold || aiIndicatesEscalation;
  }

  assessComplexity(message) {
    // Métrica simples: comprimento e número de questões
    const lengthScore = message.length > 200 ? 2 : 1;
    const questionCount = (message.match(/\?/g) || []).length;
    return lengthScore + questionCount;
  }

  assessUncertainty(response) {
    const uncertaintyWords = ['talvez', 'possivelmente', 'não tenho certeza', 'pode ser'];
    return uncertaintyWords.reduce((score, word) => 
      response.toLowerCase().includes(word) ? score + 1 : score, 0);
  }

  async createTicket(sessionId, clerkUserId, title, description, aiResponse) {
    try {
      console.log('🎫 Criando ticket - Debug info:');
      console.log('- sessionId:', sessionId);
      console.log('- clerkUserId:', clerkUserId);
      console.log('- title:', title);
      
      // Buscar dados do usuário primeiro
      let userData = null;
      let userEmail = null;
      let userName = 'Unknown Customer';
      
      // Tentar buscar no profiles
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', clerkUserId)
        .single();

      if (!profileError && profileData) {
        userData = profileData;
        userName = profileData.full_name || 'Unknown Customer';
        userEmail = profileData.email;
        console.log('✅ Dados do usuário encontrados no profiles:', userData);
      } else {
        console.log('⚠️ Usuário não encontrado no profiles');
        console.log('- clerkUserId usado:', clerkUserId);
        
        // Por enquanto, usar "Unknown Customer" mas salvar o clerkUserId nos metadados
        // para futura referência quando o usuário completar o perfil
      }

      // Generate unique ticket_number
      const { data: maxIdData } = await supabase
        .from('helpdesk_tickets')
        .select('id')
        .order('id', { ascending: false })
        .limit(1);

      const nextId = (maxIdData?.[0]?.id || 0) + 1;
      const ticketNumber = `HD-${nextId.toString().padStart(6, '0')}`;

      // Buscar histórico completo da conversa
      const conversationHistory = await this.getConversationHistory(sessionId, clerkUserId);
      
      // Formatar histórico para incluir na descrição
      let formattedHistory = '';
      if (conversationHistory && conversationHistory.length > 0) {
        formattedHistory = '\n\n=== HISTÓRICO DA CONVERSA ===\n';
        conversationHistory.forEach(msg => {
          const timestamp = new Date(msg.created_at).toLocaleString('pt-BR');
          formattedHistory += `\n[${timestamp}] ${msg.message_type.toUpperCase()}: ${msg.message}\n`;
        });
      }

      const { error } = await supabase
        .from('helpdesk_tickets')
        .insert([
          {
            session_id: sessionId,
            clerk_user_id: clerkUserId,
            ticket_number: ticketNumber,
            title: title,
            description: `Descrição: ${description}\n\nResposta da IA: ${aiResponse}${formattedHistory}`,
            category: 'support', // Default category
            priority: 'medium',
            status: 'open',
            created_at: new Date().toISOString(),
            // Adicionar metadados do usuário
            metadata: {
              user_name: userName,
              user_email: userEmail,
              clerk_user_id: clerkUserId
            }
          }
        ]);

      if (error) throw error;
      
      console.log(`✅ Ticket ${ticketNumber} criado com sucesso para usuário: ${userName} (${userEmail || 'sem email'})`);
    } catch (error) {
      console.error('Erro ao criar ticket:', error);
    }
  }

  async searchKnowledgeBase(query, limit = 5) {
    try {
      const { data, error } = await supabase
        .from('helpdesk_knowledge_base')
        .select('*')
        .or(`title.ilike.%${query}%,content.ilike.%${query}%,tags.cs.{${query}}`)
        .limit(limit);

      if (error) throw error;

      return {
        success: true,
        articles: data || []
      };
    } catch (error) {
      console.error('Erro ao buscar na base de conhecimento:', error);
      return {
        success: false,
        error: 'Erro ao buscar artigos'
      };
    }
  }
}

export default new HelpdeskService(); 