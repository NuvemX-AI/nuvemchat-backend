import OpenAI from 'openai';
import { supabase } from './supabaseClient.js'; // Ajuste o caminho se necessário
import { decrypt, getShopifySession } from './utils.js'; // Ajuste o caminho se necessário
import { redis } from './redisClient.js'; 
import { 
    buildShopifySystemPrompt, 
    fetchSpecificProductDetails, 
    fetchOrderDetails,
    getTrackingInformation,
    fetchShopifyPageContentByHandle,
    generateShopifyLink,
    fetchUserKnowledgeBase
} from './promptBuilder.js'; // Ajuste o caminho se necessário
import { getShopifyInstance } from './shopifyInitializer.js'; // Para a instância global shopify
import usageService, { ACTION_TYPES } from './usageService.js'; // IMPORTAR SERVIÇO DE USO
import { HumanInterventionService } from './humanInterventionService.js'; // NOVO: Serviço de intervenção humana
import { AudioTranscriptionService } from './audioTranscriptionService.js'; // NOVO: Serviço de transcrição de áudio
import { AILoopProtection } from './aiLoopProtection.js'; // NOVO: Proteção contra loops de IA

const shopify = getShopifyInstance();

// Mapeamento das funções de tool para facilitar a chamada
const availableToolFunctions = {
    fetchSpecificProductDetails,
    fetchOrderDetails,
    getTrackingInformation,
    fetchShopifyPageContentByHandle,
    generateShopifyLink,
};

const HISTORY_MESSAGES_LIMIT = 10; // Número de mensagens do histórico a carregar
const DEBOUNCE_TIME_MS = 8000; // 8 segundos para debounce
const activeDebounceTimers = {}; // Objeto para rastrear timers ativos

// Função para salvar/atualizar contatos
async function saveContact(contactData, instanceName) {
    try {
        // Buscar o instanceId da tabela Instance
        const { data: instanceData } = await supabase
            .from('Instance')
            .select('id')
            .eq('name', instanceName)
            .single();

        if (!instanceData?.id) {
            console.warn(`[WEBHOOK CONTACT] Instance ID não encontrado para ${instanceName}`);
            return;
        }

        const contactPayload = {
            id: contactData.id, // whatsapp ID como chave primária
            remoteJid: contactData.id,
            pushName: contactData.name || contactData.pushName || contactData.notify || null,
            profilePicUrl: contactData.profilePictureUrl || null,
            instanceId: instanceData.id,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const { error } = await supabase
            .from('Contact')
            .upsert(contactPayload, { 
                onConflict: 'id',
                ignoreDuplicates: false 
            });

        if (error) {
            console.error(`[WEBHOOK CONTACT] Erro ao salvar contato ${contactData.id}:`, error);
        } else {
            console.log(`[WEBHOOK CONTACT] Contato ${contactData.id} salvo/atualizado com sucesso`);
        }
    } catch (e) {
        console.error(`[WEBHOOK CONTACT] Exceção ao salvar contato:`, e);
    }
}

// Função para salvar/atualizar chats
async function saveChat(chatData, instanceName) {
    try {
        // Buscar o instanceId da tabela Instance
        const { data: instanceData } = await supabase
            .from('Instance')
            .select('id')
            .eq('name', instanceName)
            .single();

        if (!instanceData?.id) {
            console.warn(`[WEBHOOK CHAT] Instance ID não encontrado para ${instanceName}`);
            return;
        }

        const chatPayload = {
            id: `${instanceData.id}_${chatData.id}`, // Combinar instanceId + chatId
            remoteJid: chatData.id,
            name: chatData.name || null,
            unreadMessages: chatData.unreadCount || 0,
            instanceId: instanceData.id,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const { error } = await supabase
            .from('Chat')
            .upsert(chatPayload, { 
                onConflict: 'id',
                ignoreDuplicates: false 
            });

        if (error) {
            console.error(`[WEBHOOK CHAT] Erro ao salvar chat ${chatData.id}:`, error);
        } else {
            console.log(`[WEBHOOK CHAT] Chat ${chatData.id} salvo/atualizado com sucesso`);
        }
    } catch (e) {
        console.error(`[WEBHOOK CHAT] Exceção ao salvar chat:`, e);
    }
}

// Função para salvar mensagens
async function saveMessage(messageData, instanceName) {
    try {
        // Buscar o instanceId da tabela Instance
        const { data: instanceData } = await supabase
            .from('Instance')
            .select('id')
            .eq('name', instanceName)
            .single();

        if (!instanceData?.id) {
            console.warn(`[WEBHOOK MESSAGE] Instance ID não encontrado para ${instanceName}`);
            return;
        }

        const message = messageData.message || messageData;
        const key = messageData.key || {};
        
        // Detectar source corretamente baseado nos dados
        let source = 'unknown'; // Valor padrão
        if (messageData.source) {
            source = messageData.source.toLowerCase(); // Garantir lowercase para o enum
        } else if (key.fromMe) {
            source = 'web'; // Mensagens enviadas pelo bot
        } else {
            // Tentar detectar baseado em outros campos
            if (messageData.contextInfo?.deviceListMetadata) {
                source = 'ios'; // Padrão para mensagens com metadata
            }
        }
        
        const messagePayload = {
            id: `${instanceData.id}_${key.id}`, // Combinar instanceId + messageId
            key: key,
            pushName: messageData.pushName || null,
            participant: key.participant || null,
            messageType: Object.keys(message)[0] || 'conversation', // Primeiro tipo de mensagem encontrado
            message: message,
            contextInfo: message.contextInfo || null,
            source: source, // Usar source detectado
            messageTimestamp: messageData.messageTimestamp || Math.floor(Date.now() / 1000),
            instanceId: instanceData.id,
            status: 'received'
        };

        const { error } = await supabase
            .from('Message')
            .upsert(messagePayload, { 
                onConflict: 'id',
                ignoreDuplicates: false 
            });

        if (error) {
            console.error(`[WEBHOOK MESSAGE] Erro ao salvar mensagem ${key.id}:`, error);
        } else {
            console.log(`[WEBHOOK MESSAGE] Mensagem ${key.id} salva/atualizada com sucesso`);
        }
    } catch (e) {
        console.error(`[WEBHOOK MESSAGE] Exceção ao salvar mensagem:`, e);
    }
}

// Função para logar no Supabase de forma centralizada
async function logToSupabase(logData) {
    // console.log('[Log Supabase] Tentando registrar:', logData);
    try {
        const { error: logError } = await supabase.from('WhatsChatHistory').insert([logData]);
        if (logError) {
            console.error('[Supabase Log] Erro ao registrar no WhatsChatHistory:', logError);
        }
    } catch (e) {
        console.error('[Supabase Log] Exceção CRÍTICA ao registrar no WhatsChatHistory:', e);
    }
}

// Função para processar a mensagem após o debounce
async function processDebouncedMessage(remoteJid, instanceName, accumulatedMessageContent, originalMessageIdFromLatest, messageData = null) {
    console.log(`[Debounce] Processando mensagem para ${remoteJid} após debounce. Conteúdo: "${accumulatedMessageContent}"`);
    
    let clerkUserId; 
    let sessionId = `whatsapp:${instanceName}:${remoteJid}`; 
    let errorLoggingInfo = {
        clerk_user_id: null, // Será preenchido depois
        instance_name: instanceName,
        remote_jid: remoteJid,
        session_id: sessionId, // Incluir session_id
        user_message_to_ai: accumulatedMessageContent,
        ai_response_content: null,
        error_details: null,
        timestamp: new Date(),
        original_whatsapp_message_id: originalMessageIdFromLatest,
        message_id_from_wa: originalMessageIdFromLatest
    };

    try {
        // 1. BUSCAR CLERK USER ID
        const { data: instanceUser } = await supabase
        .from('InstanceUser')
        .select('clerk_user_id')
        .eq('instance_name', instanceName)
        .single();

        if (!instanceUser?.clerk_user_id) {
            console.error(`[Debounce] Clerk User ID não encontrado para a instância ${instanceName}`);
            return;
        }

        clerkUserId = instanceUser.clerk_user_id;
        errorLoggingInfo.clerk_user_id = clerkUserId;

        // 2. VERIFICAR PROTEÇÃO CONTRA LOOPS DE IA
        console.log(`[Debounce] Analisando proteção contra loops para ${remoteJid}`);
        const loopAnalysis = await AILoopProtection.analyzeConversation(
            instanceName, 
            remoteJid, 
            accumulatedMessageContent, 
            messageData?.pushName || ''
        );
        
        if (loopAnalysis.shouldBlock) {
            console.log(`[Debounce] 🚫 Conversa bloqueada por proteção contra loops: ${remoteJid}`, loopAnalysis.reasons);
            
            // Bloquear conversa temporariamente
            await AILoopProtection.blockConversation(
                instanceName, 
                remoteJid, 
                loopAnalysis.blockDuration, 
                loopAnalysis.reasons.join(',')
            );
            
            // Log para auditoria
            errorLoggingInfo.error_details = { 
                step: 'loop_protection_block', 
                reasons: loopAnalysis.reasons,
                duration: loopAnalysis.blockDuration
            };
            errorLoggingInfo.status = 'blocked_by_loop_protection';
        await logToSupabase(errorLoggingInfo); 
            
            return; // Não processar com IA
        }

        // 3. VERIFICAR INTERVENÇÃO HUMANA ATIVA
        console.log(`[Debounce] Verificando intervenção humana para ${clerkUserId}/${remoteJid}`);
        const interventionCheck = await HumanInterventionService.checkActiveIntervention(clerkUserId, instanceName, remoteJid);
        
        if (interventionCheck.hasIntervention) {
            console.log(`[Debounce] ⚠️ Intervenção humana ativa para ${remoteJid} - IA pausada`);
            // Se há intervenção ativa, não processar com IA
            return;
        }

        // 4. PROCESSAR ÁUDIO SE NECESSÁRIO
        let finalMessageContent = accumulatedMessageContent;
        if (messageData && AudioTranscriptionService.isAudioMessage(messageData)) {
            console.log(`[Debounce] 🎵 Mensagem de áudio detectada para ${remoteJid}`);
            
            try {
                // Buscar API Key da OpenAI
                const { data: openaiKeyData } = await supabase
                    .from('OpenAIKeys')
                    .select('encrypted_api_key')
                    .eq('clerk_user_id', clerkUserId)
                    .single();

                if (!openaiKeyData?.encrypted_api_key) {
                    console.error(`[Debounce] API Key da OpenAI não encontrada para ${clerkUserId}`);
                    finalMessageContent = "🎵 Áudio recebido, mas não foi possível processar (OpenAI não configurada)";
                } else {
                    const decryptedApiKey = decrypt(openaiKeyData.encrypted_api_key);
                    const audioUrl = AudioTranscriptionService.extractAudioUrl(messageData);
                    
                    if (audioUrl) {
                        console.log(`[Debounce] Transcrevendo áudio de ${audioUrl}`);
                        const transcriptionResult = await AudioTranscriptionService.processAudioMessage(audioUrl, decryptedApiKey, originalMessageIdFromLatest);
                        
                        if (transcriptionResult.success) {
                            finalMessageContent = AudioTranscriptionService.formatTranscriptionForAI(transcriptionResult.transcription, audioUrl);
                            console.log(`[Debounce] ✅ Áudio transcrito: "${finalMessageContent}"`);
                        } else {
                            finalMessageContent = "🎵 Áudio recebido, mas houve erro na transcrição: " + transcriptionResult.error;
                            console.error(`[Debounce] ❌ Erro na transcrição:`, transcriptionResult.error);
                        }
                    } else {
                        finalMessageContent = "🎵 Áudio recebido, mas URL não encontrada";
                    }
                }
            } catch (audioError) {
                console.error(`[Debounce] Erro ao processar áudio:`, audioError);
                finalMessageContent = "🎵 Áudio recebido, mas houve erro no processamento";
            }
            
            // Atualizar errorLoggingInfo com o conteúdo processado
            errorLoggingInfo.user_message_to_ai = finalMessageContent;
        }

        // 5. CONTINUAR COM O PROCESSAMENTO NORMAL DA IA
        console.log(`[Debounce] Processando com IA - Conteúdo final: "${finalMessageContent}"`);

        // Verificar limite de uso antes de processar
        const usageCheck = await usageService.canPerformAction(clerkUserId, ACTION_TYPES.WHATSAPP_MESSAGE);
        if (!usageCheck.allowed) {
            console.log(`[Debounce] Limite de mensagens atingido para ${clerkUserId}`);
        return; 
      }
      
      let shopDomain;
      let aiConfig = {};
      let systemPrompt;

      try {
        const { data: shopData, error: shopError } = await supabase
          .from('shopify_sessions')
          .select('shop')
          .eq('clerk_user_id', clerkUserId)
          .limit(1)
          .single();

        if (shopError && shopError.code !== 'PGRST116') { 
          console.error(`[Debounce] Erro ao buscar shopDomain para ${clerkUserId}:`, shopError);
          throw shopError; 
        }
        if (!shopData || !shopData.shop) {
          console.error(`[Debounce] Nenhum shopDomain encontrado para clerk_user_id ${clerkUserId}.`);
          errorLoggingInfo.error_details = { step: 'fetch_shop_domain_debounced', message: 'Domínio da loja Shopify não encontrado.' };
          errorLoggingInfo.status = 'error_config_shop_debounced';
          throw new Error('Domínio da loja Shopify não associado ao usuário.');
        }
        shopDomain = shopData.shop;
        console.log(`[Debounce] shopDomain '${shopDomain}' encontrado para clerk_user_id ${clerkUserId}.`);

      } catch (error) {
        console.error('[Debounce] Falha crítica ao determinar o shopDomain:', error);
        if (!errorLoggingInfo.error_details?.step_fetch_shop_domain_debounced) {
            errorLoggingInfo.error_details = { ...(errorLoggingInfo.error_details || {}), step_fetch_shop_domain_critical_debounced: error.message };
            errorLoggingInfo.status = 'error_config_shop_critical_debounced';
        }
        await logToSupabase(errorLoggingInfo);
        return;
      }

      const shopSession = await getShopifySession(shopDomain);
      if (!shopSession || !shopSession.accessToken) {
        console.error(`[Debounce] Sessão Shopify ou accessToken não encontrados para ${clerkUserId} e loja ${shopDomain}.`);
        errorLoggingInfo.error_details = { step: 'fetch_shopify_session_debounced', message: 'Configuração da loja Shopify pendente.' };
        errorLoggingInfo.status = 'error_config_session_debounced';
        await logToSupabase(errorLoggingInfo);
        return;
      }
      console.log(`[Debounce] Sessão Shopify carregada para ${shopDomain}.`);

      const { data: aiSettingsData, error: aiSettingsError } = await supabase
        .from('aisettings')
        .select('ai_name, ai_style, ai_language')
        .eq('clerk_user_id', clerkUserId)
        .single();

      if (aiSettingsError && aiSettingsError.code !== 'PGRST116') {
        console.warn(`[Debounce] Erro ao buscar configurações da IA para ${clerkUserId}. Erro:`, aiSettingsError);
        errorLoggingInfo.error_details = { ...(errorLoggingInfo.error_details || {}), step_ai_settings_debounced: aiSettingsError.message };
      }
      aiConfig = {
          aiName: aiSettingsData?.ai_name || 'Assistente Virtual',
          aiStyle: aiSettingsData?.ai_style || 'amigável e prestativo',
          aiLanguage: aiSettingsData?.ai_language || 'Português (Brasil)',
          shopDomain: shopDomain,
      };
      console.log(`[Debounce] Configurações da IA carregadas/definidas:`, aiConfig);

      let decryptedApiKey;
      try {
        const { data: keyData, error: keyError } = await supabase
          .from('OpenAIKeys')
          .select('encrypted_api_key')
          .eq('clerk_user_id', clerkUserId)
          .single();
        if (keyError && keyError.code !== 'PGRST116') throw keyError;
        if (!keyData || !keyData.encrypted_api_key) throw new Error('Chave API da OpenAI não configurada.');
        decryptedApiKey = decrypt(keyData.encrypted_api_key);
        if (!decryptedApiKey) throw new Error('Falha ao descriptografar a chave da API OpenAI.');
      } catch (error) {
        console.error('[Debounce] Erro no processo da chave OpenAI:', error);
        errorLoggingInfo.status = 'error_openai_key_debounced';
        errorLoggingInfo.error_details = { ...(errorLoggingInfo.error_details || {}), step_openai_key_debounced: error.message };
        await logToSupabase(errorLoggingInfo);
        return;
      }
      const openai = new OpenAI({ apiKey: decryptedApiKey });

        // BUSCAR BASE DE CONHECIMENTO DO USUÁRIO
        let userKnowledgeBase = null;
        try {
            userKnowledgeBase = await fetchUserKnowledgeBase(clerkUserId);
        } catch (knowledgeError) {
            console.warn(`[Debounce] Erro ao buscar base de conhecimento para usuário ${clerkUserId}:`, knowledgeError);
        }

      systemPrompt = await buildShopifySystemPrompt({
        aiName: aiConfig.aiName,
        aiStyle: aiConfig.aiStyle,
        aiLanguage: aiConfig.aiLanguage,
        shopName: aiConfig.shopDomain,
        shopify: shopify, 
        shopifySession: shopSession,
            knowledgeBaseContent: userKnowledgeBase ? userKnowledgeBase.content : null
      });
      errorLoggingInfo.system_prompt_used = systemPrompt;
      console.log(`[Debounce] System prompt gerado. Tamanho: ${systemPrompt.length}`);

      let conversationHistory = [];
      try {
        const { data: historyData, error: historyError } = await supabase
          .from('WhatsChatHistory')
          .select('user_message_to_ai, ai_response_content, ai_tool_calls') 
          .eq('session_id', sessionId)
          .order('timestamp', { ascending: false })
          .limit(HISTORY_MESSAGES_LIMIT);

        if (historyError) {
          console.warn('[Debounce] Erro ao buscar histórico da conversa:', historyError);
        } else if (historyData) {
          for (let i = historyData.length - 1; i >= 0; i--) { 
            const record = historyData[i];
            if (record.user_message_to_ai) {
              conversationHistory.push({ role: "user", content: record.user_message_to_ai });
            }
            if (record.ai_tool_calls && Array.isArray(record.ai_tool_calls) && record.ai_tool_calls.length > 0) {
              const assistantToolCallRequest = {
                role: "assistant",
                tool_calls: record.ai_tool_calls.map(tc => ({
                  id: tc.id,
                  type: "function", 
                  function: {
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
                  }
                }))
              };
              conversationHistory.push(assistantToolCallRequest);
              for (const executedToolCall of record.ai_tool_calls) {
                let toolContent;
                if (executedToolCall.function.result !== undefined) {
                  if (typeof executedToolCall.function.result === 'string') {
                    toolContent = executedToolCall.function.result;
                  } else {
                    toolContent = JSON.stringify(executedToolCall.function.result);
                  }
                } else {
                  toolContent = JSON.stringify({error: executedToolCall.function.error || 'Tool execution failed without specific error'});
                }
                conversationHistory.push({
                  role: "tool",
                  tool_call_id: executedToolCall.id,
                  name: executedToolCall.function.name,
                  content: toolContent
                });
              }
            }
            if (record.ai_response_content) {
                const lastMessageInHistory = conversationHistory[conversationHistory.length -1];
                if (!(lastMessageInHistory && lastMessageInHistory.role === 'assistant' && lastMessageInHistory.tool_calls && !lastMessageInHistory.content)) {
                    if (record.ai_response_content.trim() !== "" || !record.ai_tool_calls || record.ai_tool_calls.length === 0) {
                    conversationHistory.push({ role: "assistant", content: record.ai_response_content });
                    }
                }
            }
          }
        }
      } catch (histError) {
        console.warn('[Debounce] Exceção ao construir histórico:', histError);
      }

      const messagesForOpenAI = [
        { role: "system", content: systemPrompt },
        ...conversationHistory,
            { role: "user", content: finalMessageContent } 
        ];

        const tools = [
            {
                type: "function",
                function: {
                    name: "fetchSpecificProductDetails",
                    description: "Busca detalhes específicos de um produto na loja Shopify usando o nome ou termo de pesquisa",
                    parameters: {
                        type: "object",
                        properties: {
                            productNameQuery: {
                                type: "string",
                                description: "Nome ou termo de pesquisa do produto"
                            }
                        },
                        required: ["productNameQuery"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "fetchOrderDetails",
                    description: "Busca detalhes de um pedido específico usando o número do pedido",
                    parameters: {
                        type: "object",
                        properties: {
                            orderQuery: {
                                type: "string",
                                description: "Número do pedido a ser consultado"
                            }
                        },
                        required: ["orderQuery"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "getTrackingInformation",
                    description: "Obtém informações de rastreamento de um pacote usando o código de rastreamento",
                    parameters: {
                        type: "object",
                        properties: {
                            trackingNumber: {
                                type: "string",
                                description: "Código de rastreamento do pacote"
                            }
                        },
                        required: ["trackingNumber"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "fetchShopifyPageContentByHandle",
                    description: "Busca o conteúdo de uma página da loja Shopify usando o handle da página",
                    parameters: {
                        type: "object",
                        properties: {
                            handle: {
                                type: "string",
                                description: "Handle (identificador) da página a ser consultada"
                            }
                        },
                        required: ["handle"]
                    }
                }
            },
            {
        type: "function",
        function: {
                    name: "generateShopifyLink",
                    description: "Gera um link completo para um produto, coleção ou página da loja Shopify com parâmetros de tracking",
                    parameters: {
                        type: "object",
                        properties: {
                            linkType: {
                                type: "string",
                                description: "Tipo de link: 'product', 'collection' ou 'page'",
                                enum: ["product", "collection", "page"]
                            },
                            handle: {
                                type: "string",
                                description: "Handle (identificador) do produto, coleção ou página"
                            }
                        },
                        required: ["linkType", "handle"]
                    }
                }
            }
        ];     

      console.log("[Debounce] Enviando para OpenAI...");
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview", // Ou o modelo que estiver usando
          messages: messagesForOpenAI,
          tools: tools,
          tool_choice: "auto",
        });

      const responseMessage = response.choices[0].message;
                    errorLoggingInfo.ai_response_content = responseMessage.content;
      errorLoggingInfo.ai_tool_calls = responseMessage.tool_calls;

      if (responseMessage.tool_calls) {
        console.log("[Debounce] OpenAI solicitou tool_calls:", responseMessage.tool_calls);
        const toolExecutionPromises = responseMessage.tool_calls.map(async (toolCall) => {
          const functionName = toolCall.function.name;
          const functionToCall = availableToolFunctions[functionName];
          const functionArgs = JSON.parse(toolCall.function.arguments);
          console.log(`[Debounce] Executando tool: ${functionName} com args:`, functionArgs);
          try {
                    let functionResponse;
                    
                    // Chamada específica para cada função com parâmetros corretos
                    if (functionName === 'generateShopifyLink') {
                        // Para generateShopifyLink, precisamos passar shopSession, linkType, handle, userId, conversationId
                        functionResponse = await functionToCall(
                            shopSession, 
                            functionArgs.linkType, 
                            functionArgs.handle, 
                            clerkUserId, 
                            sessionId
                        );
                    } else if (functionName === 'getTrackingInformation') {
                        // Para getTrackingInformation, apenas trackingNumber
                        functionResponse = await functionToCall(functionArgs.trackingNumber);
                    } else if (functionName === 'fetchShopifyPageContentByHandle') {
                        // Para fetchShopifyPageContentByHandle, passar shopify, shopSession, handle
                        functionResponse = await functionToCall(shopify, shopSession, functionArgs.handle);
                    } else {
                        // Para outras funções (fetchSpecificProductDetails, fetchOrderDetails)
                        functionResponse = await functionToCall(shopify, shopSession, functionArgs.productNameQuery || functionArgs.orderQuery);
                    }
                    
            console.log(`[Debounce] Resultado da tool ${functionName}:`, functionResponse);
            toolCall.function.result = functionResponse; // Adiciona o resultado ao objeto toolCall para log
            return {
              tool_call_id: toolCall.id,
              role: "tool",
              name: functionName,
              content: typeof functionResponse === 'string' ? functionResponse : JSON.stringify(functionResponse),
            };
          } catch (toolError) {
            console.error(`[Debounce] Erro ao executar tool ${functionName}:`, toolError);
            toolCall.function.error = toolError.message; // Adiciona o erro ao objeto toolCall para log
            return {
            tool_call_id: toolCall.id,
            role: "tool",
            name: functionName,
              content: JSON.stringify({ error: toolError.message, details: "Erro durante a execução da ferramenta." }),
            };
        }
        });
        const toolResponses = await Promise.all(toolExecutionPromises);
        
        messagesForOpenAI.push(responseMessage); 
        messagesForOpenAI.push(...toolResponses); 

        console.log("[Debounce] Enviando para OpenAI com respostas das tools...");
        const secondResponse = await openai.chat.completions.create({
                model: "gpt-4-turbo-preview",
                messages: messagesForOpenAI,
            });
        const finalMessageContent = secondResponse.choices[0].message.content;
            errorLoggingInfo.ai_response_content = finalMessageContent; // Atualiza com a resposta final
        console.log("[Debounce] Resposta final da OpenAI após tools:", finalMessageContent);
        
        await redis.set(`whatsapp:${instanceName}:${remoteJid}:last_response`, finalMessageContent, 'EX', 60 * 60 * 24); // Expira em 24h
        await logToSupabase(errorLoggingInfo);
            
        // Enviar resposta final para o WhatsApp
            const sendResponse = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': process.env.EVOLUTION_API_KEY
            },
                body: JSON.stringify({ 
                    number: remoteJid.replace('@s.whatsapp.net', ''), // Remove @s.whatsapp.net se presente
                    options: { delay: 1200, presence: 'composing' }, 
                    text: finalMessageContent 
                })
            });
            
            console.log(`[Debounce] Resposta da Evolution API para envio (com tools):`, sendResponse.status, sendResponse.statusText);

            // REGISTRAR USO DA MENSAGEM WHATSAPP APÓS ENVIO BEM-SUCEDIDO
            try {
                const usageResult = await usageService.trackUsage(
                    clerkUserId, 
                    ACTION_TYPES.WHATSAPP_MESSAGE, 
                    1, 
                    { 
                        instanceName, 
                        remoteJid, 
                        messageLength: finalMessageContent.length,
                        toolsUsed: responseMessage.tool_calls?.length || 0,
                        timestamp: new Date().toISOString() 
                    }
                );
                console.log(`[Debounce] Uso registrado para ${clerkUserId}: ${usageResult.newUsage} mensagens utilizadas (${usageResult.remaining} restantes)`);
            } catch (trackError) {
                console.error(`[Debounce] Erro ao registrar uso:`, trackError);
            }

      } else {
        // Sem tool_calls, processar resposta direta
        const directMessageContent = responseMessage.content;
        console.log("[Debounce] Resposta direta da OpenAI (sem tools):", directMessageContent);
        await redis.set(`whatsapp:${instanceName}:${remoteJid}:last_response`, directMessageContent, 'EX', 60 * 60 * 24);
        await logToSupabase(errorLoggingInfo);
            
            // Corrigir formato da requisição para Evolution API
            const sendResponse = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': process.env.EVOLUTION_API_KEY
            },
                body: JSON.stringify({ 
                    number: remoteJid.replace('@s.whatsapp.net', ''), // Remove @s.whatsapp.net se presente
                    options: { delay: 1200, presence: 'composing' }, 
                    text: directMessageContent 
                })
            });
            
            console.log(`[Debounce] Resposta da Evolution API para envio:`, sendResponse.status, sendResponse.statusText);

            // REGISTRAR USO DA MENSAGEM WHATSAPP APÓS ENVIO BEM-SUCEDIDO
            try {
                const usageResult = await usageService.trackUsage(
                    clerkUserId, 
                    ACTION_TYPES.WHATSAPP_MESSAGE, 
                    1, 
                    { 
                        instanceName, 
                        remoteJid, 
                        messageLength: directMessageContent.length,
                        toolsUsed: 0,
                        timestamp: new Date().toISOString() 
                    }
                );
                console.log(`[Debounce] Uso registrado para ${clerkUserId}: ${usageResult.newUsage} mensagens utilizadas (${usageResult.remaining} restantes)`);
            } catch (trackError) {
                console.error(`[Debounce] Erro ao registrar uso:`, trackError);
            }
      }
      errorLoggingInfo.status = 'completed_debounced'; // Atualiza o status para completado
      // await logToSupabase(errorLoggingInfo); // Log já ocorre dentro dos blocos de if/else de tool_calls

    } catch (error) {
        console.error(`[Debounce] Erro CRÍTICO no processamento da mensagem para ${remoteJid}:`, error);
        errorLoggingInfo.error_details = { ...(errorLoggingInfo.error_details || {}), critical_processing_debounced: error.message };
        errorLoggingInfo.status = 'error_critical_processing_debounced';
        await logToSupabase(errorLoggingInfo);
        // Tentar enviar uma mensagem de erro genérica para o usuário do WhatsApp
        try {
            await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                    'apikey': process.env.EVOLUTION_API_KEY
              },
                body: JSON.stringify({ 
                    number: remoteJid.replace('@s.whatsapp.net', ''), // Remove @s.whatsapp.net se presente
                    options: { delay: 1200, presence: 'composing' }, 
                    text: "Desculpe, ocorreu um erro interno ao processar sua solicitação. Tente novamente mais tarde." 
                })
            });
        } catch (sendError) {
            console.error("[Debounce] Falha ao enviar mensagem de erro para o WhatsApp:", sendError);
        }
    }
}


// Função principal para lidar com webhooks da Evolution API
export async function handleEvolutionWebhook(req, res) {
    console.log('[WEBHOOK EVOLUTION ENTRY] Recebida requisição para handleEvolutionWebhook.');
    console.log('[WEBHOOK EVOLUTION HEADERS] Content-Type:', req.headers['content-type']);
    console.log('[WEBHOOK EVOLUTION RAW BODY TYPE]', typeof req.rawBody); // Verifica se o rawBody está disponível (do middleware)
    console.log('[WEBHOOK EVOLUTION BODY PARSED TYPE]', typeof req.body);
    console.log('[WEBHOOK EVOLUTION BODY INSPECTION]', JSON.stringify(req.body, null, 2)); // Loga o corpo parseado

    const { instance, event, data, date_time, apikey } = req.body;
    const instanceName = instance;
    const receivedUrlToken = req.params.secretToken;

    console.log(`[WEBHOOK EVOLUTION] Rota /api/evolution/webhook/:secretToken ATINGIDA!`);
    console.log(`[WEBHOOK EVOLUTION] Recebido para instância: ${instanceName}, Evento: ${event}, Token URL: ${receivedUrlToken ? receivedUrlToken.substring(0,10) + '...' : 'N/A'}`);

    if (!instanceName || !receivedUrlToken) {
        console.warn('[WEBHOOK EVOLUTION] Nome da instância ou token da URL ausente.');
        return res.status(200).json({ error: 'Nome da instância e token são obrigatórios na URL.', status: 'bad_request_params' });
    }

    try {
        const { data: instanceData, error: dbError } = await supabase
            .from('InstanceUser')
            .select('instance_webhook_secret, clerk_user_id')
            .eq('instance_name', instanceName)
            .single();

        if (dbError || !instanceData) {
            console.warn(`[WEBHOOK EVOLUTION] Erro ao buscar instância ou instância não encontrada no DB: ${instanceName}. Detalhes:`, dbError);
            return res.status(200).json({ error: 'Instância não configurada ou erro interno ao buscar dados da instância.', status: 'instance_not_found_or_db_error' });
  }

        const expectedToken = instanceData.instance_webhook_secret;

        if (receivedUrlToken !== expectedToken) {
            console.warn(`[WEBHOOK EVOLUTION] Tentativa de acesso com token inválido para instância ${instanceName}. Recebido: ${receivedUrlToken ? receivedUrlToken.substring(0,10) + '...' : 'N/A'}, Esperado no DB: ${expectedToken ? expectedToken.substring(0,10) + '...' : 'N/A (Não configurado?)'}`);
            return res.status(200).json({ error: 'Acesso não autorizado. Token da URL não corresponde ao esperado.', status: 'token_invalid' });
  }

        console.log(`[WEBHOOK EVOLUTION] Token de URL validado com sucesso para instância ${instanceName}.`);

        if (event === 'qrcode.updated' && data?.qrcode && typeof data.qrcode.base64 === 'string') {
            console.log(`[WEBHOOK EVOLUTION] Evento qrcode.updated recebido para ${instanceName}. QR Code (início): ${data.qrcode.base64.substring(0,30)}...`);
            try {
                const updatePayload = {
                    qr_code_base64: data.qrcode.base64,
                    qr_received_at: new Date().toISOString(),
                    instance_status: 'QRCodeReady', // Novo status
                    last_status_reason: null // Limpa a razão anterior
                };
                if (data.qrcode.pairingCode) { 
                    updatePayload.qr_pairing_code = data.qrcode.pairingCode;
                    console.log(`[WEBHOOK EVOLUTION] Pairing code recebido para ${instanceName}: ${data.qrcode.pairingCode}`);
                } else if (data.qrcode.code) {
                    updatePayload.qr_pairing_code = data.qrcode.code;
                    console.log(`[WEBHOOK EVOLUTION] Pairing code (via data.qrcode.code) recebido para ${instanceName}: ${data.qrcode.code}`);
                }

                const { error: updateError } = await supabase
                    .from('InstanceUser')
                    .update(updatePayload)
                    .eq('instance_name', instanceName);

                if (updateError) {
                    console.error(`[WEBHOOK EVOLUTION] Erro ao atualizar QR Code e status no Supabase para ${instanceName}:`, updateError);
                } else {
                    console.log(`[WEBHOOK EVOLUTION] QR Code, qr_received_at e instance_status atualizados no Supabase para ${instanceName}.`);
                }
            } catch (e) {
                console.error(`[WEBHOOK EVOLUTION] Exceção ao tentar atualizar QR Code e status no Supabase para ${instanceName}:`, e);
            }

        } else if (event === 'connection.update') {
            console.log(`[WEBHOOK EVOLUTION] Evento connection.update para ${instanceName}. Estado: ${data?.state}, Razão: ${data?.statusReason}`);
            let newStatus = 'Desconhecido';
            let reason = data?.statusReason || null;

            if (data?.state === 'open') {
                newStatus = 'Conectado';
                reason = null; // Limpa a razão se conectado
                console.log(`[WEBHOOK EVOLUTION] Instância ${instanceName} conectada (state: open).`);
            } else if (data?.state === 'close') {
                newStatus = 'Desconectado';
                 console.log(`[WEBHOOK EVOLUTION] Instância ${instanceName} desconectada (state: close). Razão: ${reason}`);
            } else if (data?.state === 'connecting') {
                newStatus = 'Conectando';
                // Não limpar a razão aqui, pode haver uma razão anterior para a tentativa de conexão
            }
            // Adicionar outros estados relevantes se necessário (ex: 'syncing', 'timeout', etc.)

            try {
                const { error: updateError } = await supabase
                    .from('InstanceUser')
                    .update({ 
                        instance_status: newStatus,
                        last_status_reason: reason,
                        // Limpar dados do QR se conectado
                        qr_code_base64: newStatus === 'Conectado' ? null : undefined,
                        qr_pairing_code: newStatus === 'Conectado' ? null : undefined,
                        qr_received_at: newStatus === 'Conectado' ? null : undefined
                     })
                    .eq('instance_name', instanceName);
                if (updateError) {
                    console.error(`[WEBHOOK EVOLUTION] Erro ao atualizar instance_status para ${newStatus} no Supabase (instância ${instanceName}):`, updateError);
                } else {
                    console.log(`[WEBHOOK EVOLUTION] instance_status atualizado para ${newStatus} no Supabase para ${instanceName}.`);
                }
            } catch (e) {
                console.error(`[WEBHOOK EVOLUTION] Exceção ao tentar atualizar instance_status no Supabase para ${instanceName}:`, e);
            }
        }

        // Processar eventos de contatos
        if (event === 'contacts.upsert') {
            console.log(`[WEBHOOK EVOLUTION] Evento contacts.upsert para ${instanceName}. Processando contatos...`);
            if (Array.isArray(data)) {
                for (const contact of data) {
                    await saveContact(contact, instanceName);
                }
            } else if (data) {
                await saveContact(data, instanceName);
            }
        }

        // Processar eventos de chats
        if (event === 'chats.upsert') {
            console.log(`[WEBHOOK EVOLUTION] Evento chats.upsert para ${instanceName}. Processando chats...`);
            if (Array.isArray(data)) {
                for (const chat of data) {
                    await saveChat(chat, instanceName);
                }
            } else if (data) {
                await saveChat(data, instanceName);
            }
        }

        // Processar apenas mensagens de entrada (messages.upsert) para evitar loops e problemas
        if (event === 'messages.upsert' && data) {
            // Salvar mensagem estrutural primeiro
            await saveMessage(data, instanceName);
            
            const remoteJid = data?.key?.remoteJid;
            const fromMe = data?.key?.fromMe;
            
            if (!remoteJid) {
                console.warn(`[WEBHOOK EVOLUTION] remoteJid não encontrado no payload para evento ${event} da instância ${instanceName}. Ignorando.`);
                return res.status(200).json({ message: "remoteJid ausente, evento ignorado", status: "missing_remote_jid" });
            }
            
            // NOVA LÓGICA: Detectar intervenção humana automática
            if (fromMe) {
                console.log(`[WEBHOOK EVOLUTION] 🤖➡️👤 Mensagem do usuário detectada para ${remoteJid} - Ativando intervenção automática`);
                
                // Buscar clerk_user_id
                const { data: instanceUser } = await supabase
                    .from('InstanceUser')
                    .select('clerk_user_id')
                    .eq('instance_name', instanceName)
                    .single();

                if (instanceUser?.clerk_user_id) {
                    // Iniciar/renovar intervenção automática (10 minutos de pausa)
                    const interventionResult = await HumanInterventionService.startIntervention(
                        instanceUser.clerk_user_id, 
                        instanceName, 
                        remoteJid, 
                        10, // 10 minutos
                        true // isAutomatic = true
                    );
                    
                    if (interventionResult.success) {
                        console.log(`[WEBHOOK EVOLUTION] ✅ Intervenção automática ativada para ${remoteJid} por 10 minutos`);
                    } else {
                        console.log(`[WEBHOOK EVOLUTION] ⚠️ Intervenção automática renovada para ${remoteJid}`);
                    }
                } else {
                    console.error(`[WEBHOOK EVOLUTION] Clerk User ID não encontrado para ${instanceName}`);
                }
                
                return res.status(200).json({ message: "Mensagem do usuário processada - intervenção ativada", status: "human_intervention_activated" });
            }
            
            // Continuar processamento normal para mensagens dos clientes (fromMe: false)
            let messageContent = "Conteúdo da mensagem não extraível/aplicável";
            if (data?.message?.conversation) {
                messageContent = data.message.conversation;
            } else if (data?.message?.extendedTextMessage?.text) {
                messageContent = data.message.extendedTextMessage.text;
            } else if (data?.message?.buttonsResponseMessage?.selectedDisplayText){ 
                messageContent = data.message.buttonsResponseMessage.selectedDisplayText;
            } else if (data?.message?.listResponseMessage?.title){ 
                messageContent = data.message.listResponseMessage.title;
            }

            const originalMessageId = data?.key?.id;

            // VERIFICAÇÃO DE PROTEÇÃO CONTRA LOOPS - ANÁLISE RÁPIDA
            const quickLoopCheck = await AILoopProtection.isConversationBlocked(instanceName, remoteJid);
            if (quickLoopCheck.blocked) {
                console.log(`[WEBHOOK EVOLUTION] 🚫 Conversa bloqueada por proteção: ${remoteJid} (${quickLoopCheck.data.reason})`);
                return res.status(200).json({ message: "Conversa bloqueada por proteção", status: "blocked_conversation" });
            }
            
            // Verificação básica de grupo (bloqueio imediato)
            if (AILoopProtection.isGroupChat(remoteJid)) {
                console.log(`[WEBHOOK EVOLUTION] 🚫 Grupo detectado, bloqueando: ${remoteJid}`);
                await AILoopProtection.blockConversation(instanceName, remoteJid, 60, 'group_chat');
                return res.status(200).json({ message: "Grupos não são suportados", status: "group_blocked" });
            }
            
            console.log(`[WEBHOOK EVOLUTION] Evento ${event} para ${instanceName} (remoteJid: ${remoteJid}). Adicionando ao debounce.`);

            const debounceKey = `${instanceName}:${remoteJid}`;
            if (activeDebounceTimers[debounceKey]) {
                clearTimeout(activeDebounceTimers[debounceKey].timer);
                     activeDebounceTimers[debounceKey].accumulatedContent += `\n${messageContent}`; 
                activeDebounceTimers[debounceKey].latestMessageId = originalMessageId; 
            } else {
                activeDebounceTimers[debounceKey] = {
                    accumulatedContent: messageContent,
                    latestMessageId: originalMessageId,
                    timer: null 
                };
            }

            activeDebounceTimers[debounceKey].timer = setTimeout(() => {
                if (activeDebounceTimers[debounceKey]) {
                    processDebouncedMessage(
                        remoteJid, 
                        instanceName, 
                        activeDebounceTimers[debounceKey].accumulatedContent,
                        activeDebounceTimers[debounceKey].latestMessageId,
                        data
                    );
                    delete activeDebounceTimers[debounceKey];
            }
        }, DEBOUNCE_TIME_MS);
        }

        return res.status(200).json({ message: "Webhook recebido e token validado.", status: "ok" });

    } catch (error) {
        console.error(`[WEBHOOK EVOLUTION] Erro CRÍTICO no handler para instância ${instanceName}:`, error);
        return res.status(200).json({ error: 'Erro interno no processamento do webhook.', status: 'internal_server_error_webhook_handler' });
  }
} 