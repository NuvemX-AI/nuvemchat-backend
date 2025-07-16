import express from 'express';
import crypto from 'crypto';
import OpenAI from 'openai';
import { htmlToText } from 'html-to-text';
import { clerkMiddleware, requireAuth } from '@clerk/express';
import { middlewares } from './usageMiddleware.js';

import { supabase } from './supabaseClient.js';
import { redis } from './redisClient.js';
import { decrypt, getShopifySession } from './utils.js'; 
import { buildShopifySystemPrompt, fetchSpecificProductDetails, fetchOrderDetails, fetchUserKnowledgeBase } from './promptBuilder.js';
import { getTrackingInfo17Track } from './trackingService.js';
import { getShopifyInstance } from './shopifyInitializer.js';

const shopify = getShopifyInstance();
const router = express.Router();

// --- ESTRUTURAS PARA DEBOUNCE DE MENSAGENS DA IA (específicas para /api/chat) ---
const userChatDebounceTimers = new Map();
const userPendingMessages = new Map();
const DEBOUNCE_DELAY_MS = 8000; 

router.post('/', clerkMiddleware(), requireAuth(), ...middlewares.aiInteraction({ allowOnError: true, trackMetadata: { source: 'playground' } }), async (req, res) => {
  console.log(`[Chat Handler ENTRY] Rota /api/chat ACESSADA. User ID from req.auth: ${req.auth?.userId}. Body keys: ${Object.keys(req.body).join(', ')}`);
  const { message: currentMessageFromRequest, shopDomain, shopifyStoreDomain, history, aiName, aiStyle, aiLanguage, orderDetailsContext, policyPageContent, chatSessionId, shopifyPagesInfo, source_medium } = req.body;
  const userId = req.auth.userId;

  // Usar shopDomain ou shopifyStoreDomain (compatibilidade)
  const finalShopDomain = shopDomain || shopifyStoreDomain;

  // Define o utm_medium a ser usado, com um padrão caso não seja fornecido
  const utmMediumToUse = source_medium || 'playground';

  if (!userId) return res.status(401).json({ error: "Usuário não autenticado." });
  if (!finalShopDomain) return res.status(400).json({ error: "shopDomain é obrigatório." });
  if (!currentMessageFromRequest) return res.status(400).json({ error: "A mensagem do usuário é obrigatória." });
  if (!chatSessionId) return res.status(400).json({ error: "chatSessionId é obrigatório." });

  // Validar se as integrações necessárias estão ativas
  try {
    // Verificar se OpenAI está configurada
    const { data: openAIData, error: openAIError } = await supabase
      .from('OpenAIKeys')
      .select('encrypted_api_key')
      .eq('clerk_user_id', userId)
      .single();

    if (openAIError || !openAIData?.encrypted_api_key) {
      return res.status(400).json({ 
        error: "Integração OpenAI não configurada. Configure sua chave API na página de Integrações." 
      });
    }

    // Verificar se Shopify está conectada
    const { data: shopifyData, error: shopifyError } = await supabase
      .from('shopify_sessions')
      .select('shop')
      .eq('shop', finalShopDomain)
      .single();

    if (shopifyError || !shopifyData) {
      return res.status(400).json({ 
        error: "Loja Shopify não conectada. Conecte sua loja na página de Integrações." 
      });
    }
  } catch (integrationError) {
    console.error('[Chat Handler] Erro ao validar integrações:', integrationError);
    return res.status(500).json({ 
      error: "Erro interno ao validar integrações. Tente novamente." 
    });
  }

  if (userChatDebounceTimers.has(userId)) {
    clearTimeout(userChatDebounceTimers.get(userId));
    console.log(`[Chat Handler Debounce] Timer anterior para ${userId} limpo.`);
    const pendingData = userPendingMessages.get(userId);
    if (pendingData && pendingData.resObjects) {
      console.log(`[Chat Handler Debounce] Requisições intermediárias (${pendingData.resObjects.length}) para ${userId} não serão respondidas explicitamente (timer reiniciado).`);
    }
    if (pendingData) {
      pendingData.resObjects = [];
    }
  }

  if (!userPendingMessages.has(userId)) {
    userPendingMessages.set(userId, { accumulatedMessages: [], resObjects: [] });
  }
  userPendingMessages.get(userId).accumulatedMessages.push(currentMessageFromRequest);
  userPendingMessages.get(userId).resObjects.push(res);
  console.log(`[Chat Handler Debounce] Mensagem "${currentMessageFromRequest.substring(0,30)}..." adicionada ao buffer de ${userId}. Buffer atual: ${userPendingMessages.get(userId).accumulatedMessages.length} msgs. Objetos res pendentes: ${userPendingMessages.get(userId).resObjects.length}`);

  const newTimerId = setTimeout(async () => {
    const pendingDataForProcessing = userPendingMessages.get(userId);
    
    userChatDebounceTimers.delete(userId);

    if (!pendingDataForProcessing || pendingDataForProcessing.accumulatedMessages.length === 0) {
      console.log(`[Chat Handler Debounce] Nenhuma mensagem acumulada para ${userId}. Não respondendo.`);
      if (pendingDataForProcessing && pendingDataForProcessing.resObjects.length > 0) {
        const finalRes = pendingDataForProcessing.resObjects.pop();
        if (finalRes && !finalRes.headersSent) {
            finalRes.status(204).send();
        }
      }
      userPendingMessages.delete(userId);
      return;
    }

    const accumulatedUserMessages = pendingDataForProcessing.accumulatedMessages;
    const finalResponseObject = pendingDataForProcessing.resObjects.pop();

    userPendingMessages.delete(userId);

    const combinedUserMessage = accumulatedUserMessages.join('. '); 
    console.log(`[Chat Handler Debounce] Mensagem combinada para ${userId}: "${combinedUserMessage.substring(0,100)}..."`);

    try {
      await supabase.from('PlaygroundChatHistory').insert({
        clerk_user_id: userId,
        session_id: chatSessionId,
        message_content: combinedUserMessage,
        sender_type: 'user',
        channel: 'playground', 
      });
      console.log(`[Chat Handler Debounce] Mensagem combinada do usuário para sessão ${chatSessionId} salva no histórico.`);
    } catch (e) {
      console.error('[Chat Handler Debounce] Exceção ao salvar mensagem combinada do usuário:', e);
    }

    try {
      let apiKeyRecord;
      try {
        const { data: keyData, error: keyError } = await supabase
            .from('OpenAIKeys')
            .select('encrypted_api_key')
            .eq('clerk_user_id', userId)
            .single();
        if (keyError && keyError.code !== 'PGRST116') throw keyError;
        apiKeyRecord = keyData;
      } catch (dbError) {
        console.error('[Chat Handler Debounce Proc] Exceção ao buscar API key:', dbError);
        if (finalResponseObject && !finalResponseObject.headersSent) return finalResponseObject.status(500).json({ error: "Exceção ao buscar configuração da API." });
        return;
      }

      if (!apiKeyRecord || !apiKeyRecord.encrypted_api_key) {
        if (finalResponseObject && !finalResponseObject.headersSent) return finalResponseObject.status(403).json({ error: "API Key da OpenAI não configurada.", errorCode: "OPENAI_KEY_NOT_SET" });
        return;
      }
      const decryptedApiKey = decrypt(apiKeyRecord.encrypted_api_key);
      const openai = new OpenAI({ apiKey: decryptedApiKey });

      const normalizedCombinedMessageForHash = combinedUserMessage.toLowerCase().trim();
      const messageHashKey = `chatmsg:${userId}:${finalShopDomain}:${crypto.createHash('md5').update(normalizedCombinedMessageForHash).digest('hex')}`;
      const EXPIRATION_SECONDS = 60 * 5; 

      try {
        const exists = await redis.exists(messageHashKey);
        if (exists) {
          console.log(`[Chat Handler Debounce Proc] Mensagem COMBINADA duplicada detectada (hash: ${messageHashKey}). Ignorando.`);
          if (finalResponseObject && !finalResponseObject.headersSent) finalResponseObject.status(204).send();
          return;
        }
      } catch (redisError) {
        console.error('[Chat Handler Debounce Proc] Erro Redis (verificação de duplicados):', redisError);
      }

      const currentShopifySession = await getShopifySession(finalShopDomain);
      if (!currentShopifySession) {
        console.warn(`[Chat Handler Debounce Proc] Não foi possível carregar a sessão da Shopify para ${finalShopDomain}.`);
      } else {
        console.log(`[Chat Handler Debounce Proc] Sessão Shopify carregada para ${finalShopDomain}.`);
      }

      // BUSCAR BASE DE CONHECIMENTO DO USUÁRIO
      let userKnowledgeBase = null;
      try {
        userKnowledgeBase = await fetchUserKnowledgeBase(userId);
      } catch (knowledgeError) {
        console.warn(`[Chat Handler Debounce Proc] Erro ao buscar base de conhecimento para usuário ${userId}:`, knowledgeError);
      }

      const systemPrompt = await buildShopifySystemPrompt({
        aiName: aiName || "Luiza",
        shopName: finalShopDomain,
        shopify: shopify, 
        shopifySession: currentShopifySession,
        aiStyle: aiStyle || "amigável e prestativo",
        aiLanguage: aiLanguage || "pt-br",
        orderDetailsContext: orderDetailsContext,
        policyPageContent: policyPageContent,
        availablePages: shopifyPagesInfo,
        knowledgeBaseContent: userKnowledgeBase ? userKnowledgeBase.content : null
      });

      const messagesForOpenAI = [{ role: "system", content: systemPrompt }];
      if (history && Array.isArray(history)) {
        messagesForOpenAI.push(...history.map(h => {
          const role = h.role === 'user' || h.role === 'assistant' || h.role === 'system' || h.role === 'tool' 
                       ? h.role 
                       : (h.sender === 'ai' ? 'assistant' : 'user');
          let content = h.content || h.text;
          if (role !== 'tool' && (content === null || typeof content === 'undefined') && !h.tool_calls) { content = ""; }
          const messageObject = { role, content };
          if (role === 'assistant' && h.tool_calls) {
              messageObject.tool_calls = h.tool_calls;
              if (content === "" || typeof content === 'undefined') { messageObject.content = null; }
          }
          if (role === 'tool' && h.tool_call_id) { messageObject.tool_call_id = h.tool_call_id; }
          return messageObject;
        }).filter(msg => typeof msg.content !== 'undefined' || (msg.role === 'assistant' && msg.tool_calls)));
      }
      messagesForOpenAI.push({ role: "user", content: combinedUserMessage });

      const tools = [
        {
          type: "function",
          function: {
            name: "fetchSpecificProductDetails",
            description: "Busca detalhes de um produto específico na loja Shopify conectada (nome, descrição, preço, imagens, variantes) com base em uma consulta de nome do produto. Use isso se o cliente perguntar sobre um produto específico. A consulta deve ser o mais próximo possível do nome do produto que o cliente mencionou.",
            parameters: {
              type: "object",
              properties: {
                productNameQuery: {
                  type: "string",
                  description: "O nome ou termo de busca para o produto. Por exemplo, 'Tênis Runner Confort', 'Cameca Star Wars'."
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
            description: "Busca detalhes de um pedido específico na loja Shopify (status, itens, envio, etc.) com base no número do pedido fornecido pelo cliente. Use esta função se o cliente perguntar sobre o status de um pedido ou quiser informações sobre um pedido que já fez.",
            parameters: {
              type: "object",
              properties: {
                orderQuery: {
                  type: "string",
                  description: "O número do pedido fornecido pelo cliente. Por exemplo, '1001', '#1002', 'pedido 1003'."
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
            description: "Busca informações de rastreamento de uma encomenda utilizando o número de rastreamento. Retorna o status atual, último evento e histórico de eventos. Use esta função se o cliente perguntar sobre o status de uma encomenda e fornecer um código de rastreamento.",
            parameters: {
              type: "object",
              properties: {
                trackingNumber: {
                  type: "string",
                  description: "O número/código de rastreamento da encomenda fornecido pelo cliente."
                },
              },
              required: ["trackingNumber"]
            }
          }
        },
        {
          type: "function",
          function: {
            name: "fetchShopifyPageContentByHandle",
            description: "Busca o conteúdo textual de uma página informativa específica da loja Shopify (como 'Política de Trocas', 'Sobre Nós', 'Termos de Serviço') usando o seu 'handle' (identificador único da URL, ex: 'politica-de-trocas'). Use esta ferramenta quando o usuário perguntar sobre informações que provavelmente estão em uma dessas páginas de conteúdo da loja. NÃO use para buscar produtos. Verifique o 'shopifyPagesInfo' no contexto para os handles disponíveis.",
            parameters: {
              type: "object",
              properties: {
                handle: {
                  type: "string",
                  description: "O 'handle' da página da Shopify a ser buscada. Por exemplo, 'politica-de-trocas'. Deve ser um dos handles listados em 'shopifyPagesInfo'."
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
            description: "Gera um link para um produto, coleção ou página específica da loja Shopify. Use APENAS APÓS CONFIRMAR COM O USUÁRIO se ele deseja o link. Priorize fornecer informações textualmente primeiro. A IA NUNCA deve gerar links para domínios externos, apenas para a loja Shopify conectada. IMPORTANTE: Ao apresentar o link para o usuário, use EXATAMENTE o valor fornecido em 'shopifyLink' pelo resultado desta ferramenta, incluindo todos os parâmetros de URL, pois eles são cruciais para rastreamento.",
            parameters: {
              type: "object",
              properties: {
                linkType: {
                  type: "string",
                  description: "O tipo de link a ser gerado. Valores permitidos: 'product', 'collection', 'page'.",
                  enum: ["product", "collection", "page"]
                },
                handle: {
                  type: "string",
                  description: "O 'handle' do produto, coleção ou página. Por exemplo, 'camiseta-modelo-x' para um produto, 'promocoes' para uma coleção, ou 'contato' para uma página."
                }
              },
              required: ["linkType", "handle"]
            }
          }
        }
      ];
      
      console.log(`[Chat Handler Debounce Proc] Iniciando chamada para OpenAI. Total de mensagens no histórico (incluindo combinada): ${messagesForOpenAI.length}. Ferramentas disponíveis: ${tools.map(t => t.function.name).join(', ')}`);
      
      let currentMessagesForOpenAICopy = [...messagesForOpenAI];
      let completion = await openai.chat.completions.create({
        model: "gpt-4.1-2025-04-14",
        messages: currentMessagesForOpenAICopy,
        tools: tools,
        tool_choice: "auto", 
      });

      let choice = completion.choices[0];
      let responseMessageFromAI = choice.message; 
      let finishReason = choice.finish_reason;
      const MAX_TOOL_CALL_ITERATIONS = 5;
      let currentIteration = 0;

      if (responseMessageFromAI) {
          currentMessagesForOpenAICopy.push(responseMessageFromAI);
      } else {
          console.warn("[Chat Handler Debounce Proc] Resposta inicial da OpenAI foi nula ou indefinida.");
      }
      
      while (responseMessageFromAI && responseMessageFromAI.tool_calls && finishReason === 'tool_calls' && currentIteration < MAX_TOOL_CALL_ITERATIONS) {
        console.log(`[Chat Handler Debounce Proc] Iteração de Tool Call #${currentIteration + 1}. Finish Reason: ${finishReason}`);
        if (responseMessageFromAI.tool_calls) {
          for (const toolCall of responseMessageFromAI.tool_calls) {
            const functionName = toolCall.function.name;
            const functionArgs = JSON.parse(toolCall.function.arguments);
            let toolResultContent;
            if (functionName === "fetchSpecificProductDetails") {
              const productNameQuery = functionArgs.productNameQuery;
              toolResultContent = await fetchSpecificProductDetails(shopify, currentShopifySession, productNameQuery)
                                      .then(details => details ? JSON.stringify(details) : JSON.stringify({ info: "Produto não encontrado." }))
                                      .catch(err => JSON.stringify({ error: "Erro ao buscar produto.", details: err.message }));
            } else if (functionName === "fetchOrderDetails") {
              const orderQuery = functionArgs.orderQuery;
              toolResultContent = await fetchOrderDetails(shopify, currentShopifySession, orderQuery)
                                      .then(details => details ? JSON.stringify(details) : JSON.stringify({ info: "Pedido não encontrado." }))
                                      .catch(err => JSON.stringify({ error: "Erro ao buscar pedido.", details: err.message }));
            } else if (functionName === "getTrackingInformation") {
                const trackingArgs = JSON.parse(toolCall.function.arguments);
                console.log(`[Chat Handler Tool Call] Chamando getTrackingInformation com args:`, trackingArgs);
                toolResultContent = await getTrackingInfo17Track(trackingArgs.trackingNumber);
                
                if (toolResultContent.error) {
                    console.warn(`[Chat Handler Tool Call] Erro da ferramenta getTrackingInformation: ${toolResultContent.message}`);
                    if (toolResultContent.details && toolResultContent.details.error && (toolResultContent.details.error.code === -18019902 || toolResultContent.details.error.code === -18019909)) {
                        toolResultContent = `O número de rastreamento ${trackingArgs.trackingNumber} foi submetido para acompanhamento. No entanto, a transportadora ainda não disponibilizou os primeiros eventos de rastreamento ou o sistema ainda está processando o registro inicial. Isso é comum para envios recentes. Por favor, tente consultar novamente em algumas horas.`;
                    } else {
                        toolResultContent = `Erro ao buscar rastreamento para ${trackingArgs.trackingNumber}: ${toolResultContent.message}`;
                    }
                } else if (toolResultContent.isEmpty) {
                    toolResultContent = `Nenhuma informação de rastreamento disponível no momento para ${trackingArgs.trackingNumber}. Isso pode acontecer se o objeto foi postado recentemente ou se a transportadora ainda não atualizou os dados. Tente novamente mais tarde.`;
                } else {
                    toolResultContent = `Status do rastreio ${trackingArgs.trackingNumber}: ${toolResultContent.status}. Último evento: ${toolResultContent.latestEvent.description} em ${toolResultContent.latestEvent.location} (${toolResultContent.latestEvent.timestamp}).`;
                }
            } else if (functionName === "fetchShopifyPageContentByHandle") {
                const pageArgs = JSON.parse(toolCall.function.arguments);
                const pageHandle = pageArgs.handle;
                console.log(`[Chat Handler Tool Call] Chamando fetchShopifyPageContentByHandle com handle: ${pageHandle}`);
                if (!currentShopifySession) {
                    toolResultContent = JSON.stringify({ error: "Sessão Shopify não disponível para buscar conteúdo da página." });
                } else {
                    try {
                        const client = new shopify.clients.Rest({ session: currentShopifySession });
                        const response = await client.get({
                            path: 'pages',
                            query: {
                                handle: pageHandle,
                                fields: 'id,title,handle,body_html'
                            }
                        });

                        if (response.body && Array.isArray(response.body.pages) && response.body.pages.length > 0) {
                            const page = response.body.pages[0];
                            if (page.handle === pageHandle) {
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
                                toolResultContent = JSON.stringify({ title: page.title, handle: page.handle, content: textContent });
                            } else {
                                toolResultContent = JSON.stringify({ error: `Página com handle '${pageHandle}' não encontrada ou handle não corresponde.` });
                            }
                        } else {
                            toolResultContent = JSON.stringify({ error: `Nenhuma página encontrada com o handle '${pageHandle}'.` });
                        }
                    } catch (error) {
                        console.error(`[Chat Handler Tool Call] Erro ao buscar conteúdo da página com handle ${pageHandle}:`, error);
                        toolResultContent = JSON.stringify({ error: `Erro ao buscar conteúdo da página ${pageHandle}: ${error.message}` });
                    }
                }
            } else if (functionName === "generateShopifyLink") {
                const { linkType, handle } = functionArgs;
                let generatedLink = '';
                if (finalShopDomain && linkType && handle) {
                  const baseUrl = `https://${finalShopDomain}`;
                  let path = '';
                  switch (linkType) {
                    case 'product':
                      path = `/products/${handle}`;
                      break;
                    case 'collection':
                      path = `/collections/${handle}`;
                      break;
                    case 'page':
                      path = `/pages/${handle}`;
                      break;
                    default:
                      toolResultContent = JSON.stringify({ error: "Tipo de link inválido fornecido para generateShopifyLink." });
                      break;
                  }
                  if (path) {
                    const fullUrl = new URL(baseUrl + path);
                    fullUrl.searchParams.set('utm_source', 'nuvemx');
                    fullUrl.searchParams.set('utm_medium', utmMediumToUse);
                    fullUrl.searchParams.set('utm_campaign', 'campaignai');
                    fullUrl.searchParams.set('utm_content', `${linkType}:${handle}`);
                    generatedLink = fullUrl.toString();
                    toolResultContent = JSON.stringify({ shopifyLink: generatedLink });
                  } else if (!toolResultContent) { // Se o path não foi setado e nenhum erro anterior
                      toolResultContent = JSON.stringify({ error: "Não foi possível construir o caminho para o link." });
                  }
                } else {
                  toolResultContent = JSON.stringify({ error: "Parâmetros insuficientes (finalShopDomain, linkType, handle) para generateShopifyLink." });
                }
            } else {
              toolResultContent = JSON.stringify({ error: `Função ${functionName} desconhecida.` });
            }
            currentMessagesForOpenAICopy.push({
              tool_call_id: toolCall.id, role: "tool", name: functionName, content: toolResultContent,
            });
          }
          completion = await openai.chat.completions.create({
            model: "gpt-4.1-2025-04-14", messages: currentMessagesForOpenAICopy, tools: tools, tool_choice: "auto",
          });
          choice = completion.choices[0];
          responseMessageFromAI = choice.message;
          finishReason = choice.finish_reason;
          if (responseMessageFromAI) currentMessagesForOpenAICopy.push(responseMessageFromAI);
          else break;
        } else break;
        currentIteration++;
      }

      if (currentIteration >= MAX_TOOL_CALL_ITERATIONS) {
        console.warn(`[Chat Handler Debounce Proc] Limite de ${MAX_TOOL_CALL_ITERATIONS} iterações de tool_calls atingido.`);
        if (finalResponseObject && !finalResponseObject.headersSent) return finalResponseObject.status(500).json({ error: "Limite de chamadas de ferramenta atingido." });
        return;
      }

      if (responseMessageFromAI && responseMessageFromAI.content) {
        if (responseMessageFromAI.content.includes("https://")) {
          console.log("[Chat Handler Debounce Proc] Resposta final da IA (contém URL):");
          console.log(responseMessageFromAI.content);
        } else {
          console.log("[Chat Handler Debounce Proc] Resposta final da IA:", responseMessageFromAI.content.substring(0, 200) + "...");
        }
        if (finalResponseObject && !finalResponseObject.headersSent) {
          finalResponseObject.setHeader('Content-Type', 'text/plain; charset=utf-8');
          finalResponseObject.status(200).send(responseMessageFromAI.content);
        }
        await supabase.from('PlaygroundChatHistory').insert({
          clerk_user_id: userId, session_id: chatSessionId, message_content: responseMessageFromAI.content,
          sender_type: 'ai', channel: 'playground', 
        });
        console.log(`[Chat Handler Debounce Proc] Resposta da IA para ${chatSessionId} salva.`);
        await redis.set(messageHashKey, "processed_successfully", "EX", EXPIRATION_SECONDS);
      } else {
        console.warn("[Chat Handler Debounce Proc] Resposta final da IA vazia. Finish reason:", finishReason);
        if (finalResponseObject && !finalResponseObject.headersSent) finalResponseObject.status(500).json({ error: "Resposta inválida da IA. Razão: " + finishReason });
        await supabase.from('PlaygroundChatHistory').insert({
          clerk_user_id: userId, session_id: chatSessionId, message_content: `Erro IA: Resposta vazia. Razão: ${finishReason || 'desconhecida'}`,
          sender_type: 'ai', channel: 'playground', metadata: { error: true, finish_reason: finishReason }
        });
      }
    } catch (error) {
      console.error("[Chat Handler Debounce Proc] Erro crítico dentro do processamento da IA:", error);
      if (finalResponseObject && !finalResponseObject.headersSent) {
        finalResponseObject.status(500).json({ error: "Erro interno no processamento da IA.", details: error.message });
      }
      await supabase.from('PlaygroundChatHistory').insert({
        clerk_user_id: userId, session_id: chatSessionId, message_content: `Erro crítico backend: ${error.message}`.substring(0,1000),
        sender_type: 'ai', channel: 'playground', metadata: { error: true, critical: true, details: error.stack?.substring(0,500) }
      });
    }
  }, DEBOUNCE_DELAY_MS);

  userChatDebounceTimers.set(userId, newTimerId);
  console.log(`[Chat Handler Debounce] Novo timer ${newTimerId} agendado para ${userId} em ${DEBOUNCE_DELAY_MS}ms.`);
});

export default router; 