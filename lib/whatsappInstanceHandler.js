import express from 'express';
import { supabase } from './supabaseClient.js'; // Ajuste o caminho se necessário
import { requireAuth } from '@clerk/express'; // Para proteger as rotas
import { generateSecureToken } from './securityUtils.js'; // Para gerar o webhook secret

const router = express.Router();

// Função auxiliar para fetch com timeout
async function fetchWithTimeout(resource, options = {}, timeout = 15000) { // Timeout padrão de 15 segundos
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal  
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    if (error.name === 'AbortError') {
      console.error(`[fetchWithTimeout] Request to ${resource} timed out after ${timeout}ms`);
      // Lançar um erro customizado ou retornar uma resposta de erro pode ser útil aqui
      // Por enquanto, vamos apenas relançar para ser pego pelo catch do chamador.
      // No entanto, para ser mais específico para o chamador, podemos criar um erro específico.
      const timeoutError = new Error(`Request timed out after ${timeout}ms`);
      timeoutError.name = 'TimeoutError'; // Para identificar o tipo de erro
      throw timeoutError;
    }
    throw error; // Relança outros erros
  }
}

// Funções auxiliares (se houver alguma específica que possa ser movida ou se precisar de novas)
// Por enquanto, manteremos a lógica diretamente nas rotas para simplificar a migração inicial.

// Rota para CRIAR uma instância do WhatsApp
// ANTERIORMENTE: app.post('/api/whatsapp/instance/create', ...)
router.post('/create', requireAuth({ unauthorized: (res) => res.status(401).json({ message: "Usuário não autenticado." }) }), async (req, res) => {
  const clerkUserId = req.auth.userId;
  console.log('[Instance Create Handler] Corpo da requisição recebido:', JSON.stringify(req.body, null, 2));
  const { requestedInstanceName } = req.body;

  console.log(`[Instance Create Handler] Após desestruturação: typeof requestedInstanceName = ${typeof requestedInstanceName}, valor = "${requestedInstanceName}", startsWith('nuvemx-whatsapp-'): ${typeof requestedInstanceName === 'string' && requestedInstanceName.startsWith('nuvemx-whatsapp-')}`);

  if (!requestedInstanceName || (typeof requestedInstanceName === 'string' && !requestedInstanceName.startsWith('nuvemx-whatsapp-')) || typeof requestedInstanceName !== 'string') {
    console.error(`[Instance Create Handler] CONDIÇÃO DE ERRO ATINGIDA. instanceName ausente, em formato inválido ou não é string. Corpo completo: ${JSON.stringify(req.body)}, Tipo de requestedInstanceName: ${typeof requestedInstanceName}, Valor de requestedInstanceName: "${requestedInstanceName}"`);
    return res.status(400).json({ message: 'Nome da instância ausente ou em formato inválido.' });
  }

  if (requestedInstanceName !== `nuvemx-whatsapp-${clerkUserId}`) {
    console.error(`[Instance Create Handler] Discrepância de segurança: instanceName (${requestedInstanceName}) não corresponde ao clerkUserId autenticado (${clerkUserId}).`);
    return res.status(403).json({ message: 'Não autorizado a criar ou gerenciar esta instância.' });
  }
  
  const instanceName = requestedInstanceName;
  let newWebhookSecret = null;

  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.error('[Instance Create Handler] Configuração da API da Evolution ausente no servidor (URL ou KEY).');
    return res.status(500).json({ message: 'Configuração da API da Evolution ausente no servidor.' });
  }

  console.log(`[Instance Create Handler] Rota /create chamada para usuário ${clerkUserId}, instância ${instanceName}`);

  // VERIFICAR SE USUÁRIO TEM OPENAI E SHOPIFY CONECTADOS ANTES DE PERMITIR WHATSAPP
  try {
    console.log(`[Instance Create Handler] Verificando pré-requisitos (OpenAI + Shopify) para ${clerkUserId}`);
    
    // Verificar OpenAI
    const { data: openaiData, error: openaiError } = await supabase
      .from('OpenAIKeys')
      .select('encrypted_api_key')
      .eq('clerk_user_id', clerkUserId)
      .single();

    if (openaiError && openaiError.code !== 'PGRST116') {
      console.error('[Instance Create Handler] Erro ao verificar OpenAI:', openaiError);
      throw openaiError;
    }

    if (!openaiData || !openaiData.encrypted_api_key) {
      console.log(`[Instance Create Handler] OpenAI não configurada para ${clerkUserId}`);
      return res.status(400).json({ 
        message: 'Para conectar o WhatsApp, você precisa primeiro conectar sua conta OpenAI.',
        missingIntegration: 'openai'
      });
    }

    // Verificar Shopify
    const { data: shopifyData, error: shopifyError } = await supabase
      .from('shopify_sessions')
      .select('shop, access_token')
      .eq('clerk_user_id', clerkUserId)
      .single();

    if (shopifyError && shopifyError.code !== 'PGRST116') {
      console.error('[Instance Create Handler] Erro ao verificar Shopify:', shopifyError);
      throw shopifyError;
    }

    if (!shopifyData || !shopifyData.shop || !shopifyData.access_token) {
      console.log(`[Instance Create Handler] Shopify não configurada para ${clerkUserId}`);
      return res.status(400).json({ 
        message: 'Para conectar o WhatsApp, você precisa primeiro conectar sua loja Shopify.',
        missingIntegration: 'shopify'
      });
    }

    console.log(`[Instance Create Handler] ✅ Pré-requisitos verificados - OpenAI: ${openaiData.encrypted_api_key ? 'OK' : 'FALHA'}, Shopify: ${shopifyData.shop || 'FALHA'}`);
    
  } catch (error) {
    console.error('[Instance Create Handler] Erro ao verificar pré-requisitos:', error);
    return res.status(500).json({ message: 'Erro ao verificar integrações necessárias.' });
  }

  try {
    let instanceUserLink = null;
    const { data: existingLink, error: selectLinkError } = await supabase
      .from('InstanceUser')
      .select('*')
      .eq('instance_name', instanceName)
      .eq('clerk_user_id', clerkUserId)
      .single();

    if (selectLinkError && selectLinkError.code !== 'PGRST116') {
      console.error('[Instance Create Handler] Erro ao verificar InstanceUser no Supabase:', selectLinkError);
      throw selectLinkError;
    }

    if (existingLink) {
      console.log(`[Instance Create Handler] Link InstanceUser já existe para ${instanceName}. Usando webhook secret existente: ${existingLink.instance_webhook_secret.substring(0,6)}...`);
      instanceUserLink = existingLink;
      newWebhookSecret = existingLink.instance_webhook_secret;
      const { error: updateLinkError } = await supabase
        .from('InstanceUser')
        .update({ 
            instance_status: 'PendenteDeLeitura', 
            qr_code_base64: null,
            qr_pairing_code: null,
            qr_received_at: null, 
            last_status_reason: null
        })
        .eq('id', existingLink.id);
      if (updateLinkError) {
          console.error('[Instance Create Handler] Erro ao ATUALIZAR InstanceUser existente:', updateLinkError);
      }
    } else {
      console.log(`[Instance Create Handler] Nenhum link InstanceUser encontrado para ${instanceName}. Criando novo.`);
      newWebhookSecret = generateSecureToken();
      console.log(`[Instance Create Handler] Gerado novo instance_webhook_secret para ${instanceName}: ${newWebhookSecret.substring(0, 6)}...`);
      
      const { data: newLinkData, error: insertLinkError } = await supabase
      .from('InstanceUser')
        .insert({
          clerk_user_id: clerkUserId,
          instance_name: instanceName,
          instance_webhook_secret: newWebhookSecret,
          instance_status: 'PendenteDeLeitura',
        })
        .select()
      .single();

      if (insertLinkError) {
        console.error('[Instance Create Handler] Erro ao criar novo link InstanceUser no Supabase:', insertLinkError);
        throw insertLinkError;
      }
      instanceUserLink = newLinkData;
      console.log(`[Instance Create Handler] Novo link InstanceUser salvo no Supabase para ${instanceName}.`);
    }

    if (!newWebhookSecret) {
        console.error('[Instance Create Handler] Falha crítica: newWebhookSecret não foi definido após lógica do InstanceUser.');
        return res.status(500).json({ message: 'Erro interno ao determinar o segredo para a instância.' });
    }
    
    let finalEvolutionInstanceData;
    let evolutionApiCallSuccessful = false; 
    let evolutionApiResponseStatus = 500; 

    console.log(`[Instance Create Handler] Verificando estado da instância ${instanceName} com a Evolution API.`);
    const checkStateUrl = `${EVOLUTION_API_URL}/instance/connectionState/${instanceName}`;
    try {
      const checkStateResponse = await fetchWithTimeout(checkStateUrl, {
        method: 'GET',
        headers: { 'apikey': EVOLUTION_API_KEY }
      });
      evolutionApiResponseStatus = checkStateResponse.status;
      const currentEvolutionStateText = await checkStateResponse.text();
      let currentEvolutionStateData;
      try {
        currentEvolutionStateData = JSON.parse(currentEvolutionStateText);
      } catch (e) {
        console.warn(`[Instance Create Handler] Resposta de /connectionState para ${instanceName} não é JSON: ${currentEvolutionStateText.substring(0,200)}`);
      }

      if (checkStateResponse.ok && currentEvolutionStateData && currentEvolutionStateData.instance && currentEvolutionStateData.instance.state) {
        const state = currentEvolutionStateData.instance.state;
        console.log(`[Instance Create Handler] Instância ${instanceName} encontrada na Evolution. Estado: ${state}`);
        
        if (state === 'open') {
          console.log(`[Instance Create Handler] Instância ${instanceName} já está 'open'.`);
          await supabase.from('InstanceUser').update({ instance_status: 'Conectado', qr_code_base64: null, qr_pairing_code: null, qr_received_at: null, last_status_reason: null }).eq('id', instanceUserLink.id);
          const instanceDetails = currentEvolutionStateData.instance || {};
          instanceDetails.name = instanceName; 
          instanceDetails.status = 'open';     
          return res.status(200).json({
            message: 'Instância já está conectada.',
            instance: instanceDetails,
            qrcode: null
          });
        } else {
          console.log(`[Instance Create Handler] Instância ${instanceName} existe (estado: ${state}). Tentando buscar QR.`);
          const fetchQrUrl = `${EVOLUTION_API_URL}/instance/qrcode/${instanceName}`;
          const fetchQrResponse = await fetchWithTimeout(fetchQrUrl, {
            method: 'GET',
            headers: { 'apikey': EVOLUTION_API_KEY }
          });
          evolutionApiResponseStatus = fetchQrResponse.status;
          const qrDataText = await fetchQrResponse.text();
          let qrData;
          try {
            qrData = JSON.parse(qrDataText);
          } catch(e) {
            console.warn(`[Instance Create Handler] Resposta de /qrcode para ${instanceName} não é JSON: ${qrDataText.substring(0,200)}`);
          }

          if (fetchQrResponse.ok && qrData && (qrData.base64 || qrData.pairingCode)) {
            console.log(`[Instance Create Handler] QR code existente obtido para ${instanceName}.`);
            const instanceDetailsForQr = currentEvolutionStateData.instance || {};
            instanceDetailsForQr.name = instanceName;
            instanceDetailsForQr.status = state;

            finalEvolutionInstanceData = {
              instance: instanceDetailsForQr,
              qrcode: { base64: qrData.base64, pairingCode: qrData.pairingCode || qrData.code, urlCode: qrData.urlCode },
              hash: currentEvolutionStateData.hash || qrData.hash || (currentEvolutionStateData.instance ? currentEvolutionStateData.instance.token : null)
            };
            evolutionApiCallSuccessful = true; 
          } else {
            console.warn(`[Instance Create Handler] Falha ao buscar QR para instância existente ${instanceName} (Status: ${fetchQrResponse.status}). Prosseguirá para tentativa de 'create'.`);
          }
        }
      } else {
        console.log(`[Instance Create Handler] Instância ${instanceName} não encontrada na Evolution ou erro ao buscar estado (Status Check: ${checkStateResponse.status}). Prosseguirá para tentativa de 'create'.`);
      }
    } catch (fetchStateOrQrError) {
      console.error(`[Instance Create Handler] Erro de rede ou outro ao verificar estado/QR da Evolution para ${instanceName}:`, fetchStateOrQrError);
      evolutionApiResponseStatus = 503;
    }

    if (!evolutionApiCallSuccessful) {
      console.log(`[Instance Create Handler] Procedendo com a chamada a /instance/create para ${instanceName}.`);
    const evolutionInstancePayload = {
      instanceName: instanceName,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
      webhook: null
    };
    
    const webhookBaseUrl = process.env.EVOLUTION_WHATSAPP_WEBHOOK_URL_BASE;
    if (webhookBaseUrl && newWebhookSecret) {
      const cleanBaseUrl = webhookBaseUrl.endsWith('/') ? webhookBaseUrl.slice(0, -1) : webhookBaseUrl;
        const dynamicWebhookUrlUsed = `${cleanBaseUrl}/${newWebhookSecret}`;
      evolutionInstancePayload.webhook = {
        url: dynamicWebhookUrlUsed,
        enabled: true,
        webhook_by_events: false,
        events: [
          "QRCODE_UPDATED", "MESSAGES_UPSERT", "MESSAGES_UPDATE", "MESSAGES_DELETE",
          "SEND_MESSAGE", "CONNECTION_UPDATE", "CALLS_UPDATE",
          "TYPEBOT_START", "TYPEBOT_CHANGE_STATUS", "PRESENCE_UPDATE", "CONTACTS_UPDATE",
          "CHATS_UPDATE", "CHATS_DELETE", "GROUPS_UPDATE", "GROUP_PARTICIPANTS_UPDATE",
          "CONNECTION_QRCODE_UPDATED"
        ]
      };
        console.log(`[Instance Create Handler] Configurando webhook dinâmico para Evolution API (/create): ${dynamicWebhookUrlUsed}`);
    } else {
        console.warn(`[Instance Create Handler] EVOLUTION_WHATSAPP_WEBHOOK_URL_BASE não definida ou newWebhookSecret ausente. Webhook não será configurado na Evolution API para ${instanceName} via /create.`);
    }

    console.log('[Instance Create Handler] Payload para Evolution API (instance/create):', JSON.stringify(evolutionInstancePayload, null, 2));

      const evolutionCreateResponse = await fetchWithTimeout(`${EVOLUTION_API_URL}/instance/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_API_KEY
      },
      body: JSON.stringify(evolutionInstancePayload)
    });

      evolutionApiResponseStatus = evolutionCreateResponse.status;
      const responseText = await evolutionCreateResponse.text();
    try {
        finalEvolutionInstanceData = JSON.parse(responseText);
    } catch (e) {
      console.error('[Instance Create Handler] Resposta da Evolution API (instance/create) não é JSON:', responseText.substring(0, 500));
      }
      
      if (evolutionCreateResponse.ok && finalEvolutionInstanceData) {
        evolutionApiCallSuccessful = true;
        console.log('[Instance Create Handler] Resposta da Evolution API (instance/create) OK:', JSON.stringify(finalEvolutionInstanceData, null, 2));
      } else {
        evolutionApiCallSuccessful = false; 
        console.error(`[Instance Create Handler] Erro ao criar/atualizar instância na Evolution API (instance/create). Status: ${evolutionApiResponseStatus}, Resposta:`, finalEvolutionInstanceData || responseText.substring(0,500));
      }
    }

    if (evolutionApiCallSuccessful && finalEvolutionInstanceData) {
      if (finalEvolutionInstanceData.instance && finalEvolutionInstanceData.instance.status === 'open') {
        console.log(`[Instance Create Handler] Instância ${instanceName} conectada (ou já estava) após processamento final.`);
        await supabase.from('InstanceUser').update({ 
          instance_status: 'Conectado', 
          qr_code_base64: null, 
          qr_pairing_code: null, 
          qr_received_at: null,
          last_status_reason: null
        }).eq('id', instanceUserLink.id);
      } else if (finalEvolutionInstanceData.qrcode && (finalEvolutionInstanceData.qrcode.base64 || finalEvolutionInstanceData.qrcode.pairingCode)) {
        console.log('[Instance Create Handler] QR Code recebido/atualizado. Salvando no Supabase.');
      const updatePayload = {
          qr_code_base64: finalEvolutionInstanceData.qrcode.base64,
          qr_pairing_code: finalEvolutionInstanceData.qrcode.pairingCode || finalEvolutionInstanceData.qrcode.code,
        qr_received_at: new Date().toISOString(),
        instance_status: 'AguardandoLeitura',
        last_status_reason: null
      };
      const { error: updateError } = await supabase
        .from('InstanceUser')
        .update(updatePayload)
        .eq('id', instanceUserLink.id);
      
      if (updateError) {
          console.error('[Instance Create Handler] Erro ao salvar QR Code no Supabase após sucesso da API Evolution:', updateError);
        } else {
          console.log('[Instance Create Handler] QR Code e status \'AguardandoLeitura\' salvos no Supabase.');
        }
      } else {
         console.log(`[Instance Create Handler] API Evolution OK, mas sem QR imediato ou status 'open'. Status da instância: ${finalEvolutionInstanceData.instance?.status}. O polling do frontend deve resolver.`);
         if (finalEvolutionInstanceData.instance && finalEvolutionInstanceData.instance.status) {
            let nuvemStatus = 'PendenteDeLeitura'; 
            if (finalEvolutionInstanceData.instance.status === 'connecting') nuvemStatus = 'IniciandoConexao';
            await supabase.from('InstanceUser').update({
                instance_status: nuvemStatus,
                last_status_reason: `Evolution state: ${finalEvolutionInstanceData.instance.status}`
            }).eq('id', instanceUserLink.id);
         }
    }

      return res.status(200).json({ 
      message: 'Solicitação de criação/conexão de instância processada.',
        instance: finalEvolutionInstanceData.instance,
        qrcode: finalEvolutionInstanceData.qrcode,
        hash: finalEvolutionInstanceData.hash
      });

    } else {
      console.error(`[Instance Create Handler] Falha final na interação com a Evolution API para ${instanceName}. Status da última chamada: ${evolutionApiResponseStatus}. Data:`, finalEvolutionInstanceData);
      const errorDetail = finalEvolutionInstanceData ? (finalEvolutionInstanceData.message || finalEvolutionInstanceData.error || JSON.stringify(finalEvolutionInstanceData).substring(0,200)) : "Erro desconhecido da API Evolution";
      await supabase.from('InstanceUser').update({ 
        instance_status: 'Erro', 
        last_status_reason: `Evolution API Error (${evolutionApiResponseStatus}): ${String(errorDetail).substring(0,150)}` 
      }).eq('id', instanceUserLink.id);
      
      return res.status(evolutionApiResponseStatus >= 400 ? evolutionApiResponseStatus : 502).json({ 
        message: 'Erro da Evolution API ao processar instância',
        details: errorDetail,
        evolutionResponseStatus: evolutionApiResponseStatus
      });
    }

  } catch (error) {
    console.error(`[Instance Create Handler] Erro CRÍTICO na rota /create para ${clerkUserId} / ${req.body.requestedInstanceName}:`, error);
    if (error.name === 'TimeoutError') {
      return res.status(504).json({ message: 'Gateway Timeout: A API da Evolution demorou muito para responder durante a criação da instância.' });
    }
    res.status(500).json({
      message: 'Erro interno do servidor ao processar a criação da instância.',
      errorDetails: error.message,
      errorStack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Rota para obter STATUS de uma instância
router.get('/status/:instanceName', requireAuth(), async (req, res) => {
  const { instanceName } = req.params;
  const { userId } = req.auth;

  console.log(`[API Get Status Handler] Rota /status/${instanceName} chamada por usuário ${userId}`);

  if (!instanceName || !instanceName.startsWith('nuvemx-whatsapp-')) {
    console.warn(`[API Get Status Handler] Tentativa de acesso com instanceName inválido: ${instanceName} por usuário ${userId}`);
    return res.status(400).json({ message: 'Nome de instância inválido.' });
  }
  const expectedInstanceName = `nuvemx-whatsapp-${userId}`;
  if (instanceName !== expectedInstanceName) {
    console.warn(`[API Get Status Handler] Usuário ${userId} tentando acessar instância ${instanceName} que não lhe pertence. Esperado: ${expectedInstanceName}`);
    return res.status(403).json({ message: 'Acesso não autorizado a esta instância.' });
  }

  try {
    const { data: supabaseInstanceData, error: supabaseError } = await supabase
      .from('InstanceUser')
      .select('instance_status, qr_code_base64, qr_pairing_code, last_status_reason, qr_received_at')
      .eq('instance_name', instanceName)
      .eq('clerk_user_id', userId)
      .single();

    if (supabaseError && supabaseError.code !== 'PGRST116') {
      console.error(`[API Get Status Handler] Erro ao buscar dados da instância ${instanceName} no Supabase:`, supabaseError);
      return res.status(500).json({ message: "Erro ao consultar dados da instância.", details: supabaseError.message });
    }
    
    const evolutionBaseUrl = process.env.EVOLUTION_API_URL;
    const evolutionApiKey = process.env.EVOLUTION_API_KEY;
    let evolutionApiState = null;
    let rawEvolutionResponse = null;

    if (evolutionBaseUrl && evolutionApiKey) {
      const fetchUrl = `${evolutionBaseUrl}/instance/connectionState/${instanceName}`;
      try {
        const evolutionResponse = await fetchWithTimeout(fetchUrl, {
          method: 'GET',
          headers: { 'apikey': evolutionApiKey },
        });
        const evoResponseText = await evolutionResponse.text();
        try {
            rawEvolutionResponse = JSON.parse(evoResponseText); 
        } catch (e) {
            console.warn(`[API Get Status Handler] Resposta da Evolution API para ${instanceName} (connectionState) não é JSON: ${evoResponseText.substring(0,100)}`);
            rawEvolutionResponse = { error: "Evolution API non-JSON response", details: evoResponseText.substring(0,200)};
        }
        
        if (evolutionResponse.ok && rawEvolutionResponse) {
          evolutionApiState = rawEvolutionResponse.state || (rawEvolutionResponse.instance && rawEvolutionResponse.instance.state);
          console.log(`[API Get Status Handler] Estado da Evolution API para ${instanceName}: ${evolutionApiState}`);
        } else {
          console.warn(`[API Get Status Handler] Erro ao buscar estado da Evolution API para ${instanceName}. Status: ${evolutionResponse.status}, Detalhes: ${evoResponseText.substring(0,200)}`);
        }
      } catch (evoError) {
        console.error(`[API Get Status Handler] Exceção ao consultar Evolution API para ${instanceName}:`, evoError);
        rawEvolutionResponse = { error: "Exception during Evolution API call", details: evoError.message };
      }
    } else {
        console.warn("[API Get Status Handler] Variáveis de ambiente da Evolution API não configuradas. Pulando consulta à API.");
    }

    const finalStatusFromSupabase = supabaseInstanceData?.instance_status || 'Desconhecido';
    let combinedStatus = finalStatusFromSupabase;
    if (evolutionApiState === 'open' || evolutionApiState === 'connecting') {
        combinedStatus = evolutionApiState;
    }

    const qrBase64FromSupabase = supabaseInstanceData?.qr_code_base64 || null;
    const qrPairingFromSupabase = supabaseInstanceData?.qr_pairing_code || null;

    if (!supabaseInstanceData) {
        console.log(`[API Get Status Handler] Instância ${instanceName} não encontrada no Supabase. Retornando com base na API da Evolution se disponível.`);
        return res.status(200).json({
            message: "Status da instância recuperado (API da Evolution ou padrão).",
            instanceName: instanceName,
            status: evolutionApiState || 'Desconectado',
            instance: {
                instanceName: instanceName,
                status: evolutionApiState || 'Desconectado',
                state: evolutionApiState,
                qr_code_base64: null, 
                qr_pairing_code: null, 
                last_status_reason: null,
                qr_received_at: null
            },
            rawEvolutionResponse: rawEvolutionResponse
        });
    }

    res.status(200).json({
      message: "Status da instância recuperado.",
      instanceName: instanceName,
      status: combinedStatus, 
      instance: {
        instanceName: instanceName,
        status: combinedStatus, 
        state: evolutionApiState || supabaseInstanceData?.instance_status,
        qr_code_base64: qrBase64FromSupabase,
        qr_pairing_code: qrPairingFromSupabase,
        last_status_reason: supabaseInstanceData?.last_status_reason,
        qr_received_at: supabaseInstanceData?.qr_received_at,
      },
      rawEvolutionResponse: rawEvolutionResponse
    });

  } catch (error) {
    console.error(`[API Get Status Handler] Erro interno no servidor ao buscar status da instância ${instanceName}:`, error);
    if (error.name === 'TimeoutError') {
      return res.status(504).json({ message: 'Gateway Timeout: A API da Evolution demorou muito para responder à consulta de status.'});
    }
    res.status(500).json({ 
      message: "Erro interno do servidor.", 
      details: error.message,
      instanceName: instanceName,
      status: 'internal_server_error'
    });
  }
});

// Rota para DELETAR uma instância
router.delete('/delete/:instanceName', requireAuth(), async (req, res) => {
  const { instanceName } = req.params;
  const { userId } = req.auth;

  console.log(`[API Delete Handler] INÍCIO da requisição DELETE para /delete/${instanceName} por usuário ${userId}`);

  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.error('[API Delete Handler] EVOLUTION_API_URL ou EVOLUTION_API_KEY não configurados.');
    return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
  }

  try {
    console.log(`[API Delete Handler] Verificando propriedade da instância ${instanceName} para usuário ${userId} no Supabase.`);
    const { data: instanceData, error: instanceError } = await supabase
      .from('InstanceUser')
      .select('clerk_user_id')
      .eq('instance_name', instanceName)
      .eq('clerk_user_id', userId)
      .single();

    if (instanceError && instanceError.code !== 'PGRST116') {
      console.error(`[API Delete Handler] Erro ao verificar propriedade da instância ${instanceName}:`, instanceError);
      return res.status(500).json({ error: 'Erro ao verificar propriedade da instância.' });
    }

    if (!instanceData || instanceData.clerk_user_id !== userId) {
      console.warn(`[API Delete Handler] Tentativa não autorizada de deletar ${instanceName} por ${userId}. Instância não encontrada ou não pertence ao usuário.`);
      return res.status(404).json({ error: 'Instância não encontrada para este usuário.' });
    }
    console.log(`[API Delete Handler] Usuário ${userId} autorizado a deletar ${instanceName}.`);

  } catch (dbError) {
    console.error(`[API Delete Handler] Exceção CRÍTICA ao verificar propriedade ${instanceName} no Supabase:`, dbError);
    return res.status(500).json({ error: 'Erro interno do servidor ao verificar instância.' });
  }

  const evolutionDeleteUrl = `${EVOLUTION_API_URL}/instance/delete/${instanceName}`;
  console.log(`[API Delete Handler] Tentando deletar na Evolution API: ${evolutionDeleteUrl}`);

  try {
    const evolutionResponse = await fetchWithTimeout(evolutionDeleteUrl, {
      method: 'DELETE',
      headers: { 'apikey': EVOLUTION_API_KEY }
    });
    let evolutionResponseData;
    try {
        evolutionResponseData = await evolutionResponse.json();
    } catch (e) {
        const textResponse = await evolutionResponse.text().catch(() => 'Corpo não lido da Evolution API.');
        console.warn(`[API Delete Handler] Resposta da Evolution API (delete) não é JSON. Status: ${evolutionResponse.status}, Corpo: ${textResponse.substring(0,200)}`);
        evolutionResponseData = { message: textResponse.substring(0,200), status_from_text: evolutionResponse.status };
    }
    
    console.log(`[API Delete Handler] Resposta da Evolution API para delete ${instanceName}: Status ${evolutionResponse.status}`, evolutionResponseData);

    if (evolutionResponse.ok || evolutionResponse.status === 404) {
      console.log(`[API Delete Handler] Sucesso ou 404 (instância já não existe) na Evolution API para ${instanceName}. Procedendo para limpar do Supabase.`);
      try {
        console.log(`[API Delete Handler] Tentando remover ${instanceName} do Supabase para usuário ${userId}.`);
        const { error: deleteDbError } = await supabase
          .from('InstanceUser')
          .delete()
          .eq('instance_name', instanceName)
          .eq('clerk_user_id', userId);

        if (deleteDbError) {
          console.error(`[API Delete Handler] ERRO ao remover ${instanceName} do Supabase:`, deleteDbError);
           // Mesmo com erro no Supabase, a deleção na Evolution pode ter ocorrido. Decidir a resposta.
           // Por ora, informamos sucesso geral mas logamos o erro específico do Supabase.
          res.status(200).json({ 
            success: true, 
            message: 'Instância processada para remoção. Verifique logs para detalhes da limpeza no banco de dados.', 
            details: evolutionResponseData,
            supabase_cleanup_error: deleteDbError.message
          });
        } else {
          console.log(`[API Delete Handler] Instância ${instanceName} REMOVIDA com sucesso do Supabase.`);
          res.status(200).json({ success: true, message: 'Instância removida com sucesso.', details: evolutionResponseData });
        }
      } catch (dbCleanupError) {
        console.error(`[API Delete Handler] Exceção CRÍTICA ao remover ${instanceName} do Supabase:`, dbCleanupError);
        res.status(500).json({ 
            success: false, 
            error: 'Instância processada na API, mas falha crítica na limpeza do banco de dados.', 
            details: evolutionResponseData,
            supabase_cleanup_exception: dbCleanupError.message
         });
      }
    } else {
      console.warn(`[API Delete Handler] Falha ao deletar ${instanceName} na Evolution API. Status: ${evolutionResponse.status}`, evolutionResponseData);
      res.status(evolutionResponse.status).json({ success: false, error: `Falha ao deletar na API da Evolution`, details: evolutionResponseData });
    }
  } catch (error) {
    console.error(`[API Delete Handler] Erro de REDE ou TIMEOUT ao deletar ${instanceName} na Evolution API:`, error);
    if (error.name === 'TimeoutError') {
      return res.status(504).json({ success: false, error: 'Gateway Timeout: A API da Evolution demorou muito para responder à solicitação de deleção.' });
    }
    res.status(500).json({ success: false, error: 'Erro de comunicação com a API da Evolution.', details: error.message });
  }
});

// Rota para LOGOUT de uma instância
router.delete('/logout/:instanceName', requireAuth(), async (req, res) => {
  const { instanceName } = req.params;
  const { userId } = req.auth;

  console.log(`[WhatsApp Handler] Recebida requisição DELETE para /logout/${instanceName} para usuário ${userId}`);

  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.error('[WhatsApp Handler Logout] EVOLUTION_API_URL ou EVOLUTION_API_KEY não configurados.');
    return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
  }

  try {
    const { data: instanceData, error: instanceError } = await supabase
      .from('InstanceUser')
      .select('clerk_user_id')
      .eq('instance_name', instanceName)
      .single();

    if (instanceError && instanceError.code !== 'PGRST116') {
      console.error(`[WhatsApp Handler Logout] Erro ao verificar propriedade ${instanceName}:`, instanceError);
      return res.status(500).json({ error: 'Erro ao verificar propriedade da instância.' });
    }

    if (!instanceData || instanceData.clerk_user_id !== userId) {
      console.warn(`[WhatsApp Handler Logout] Tentativa não autorizada de logout ${instanceName} por ${userId}.`);
      return res.status(404).json({ error: 'Instância não encontrada para este usuário.' });
    }
    console.log(`[WhatsApp Handler Logout] Usuário ${userId} autorizado a fazer logout de ${instanceName}.`);

  } catch (dbError) {
    console.error(`[WhatsApp Handler Logout] Exceção ao verificar propriedade ${instanceName}:`, dbError);
    return res.status(500).json({ error: 'Erro interno do servidor ao verificar instância.' });
  }

  const evolutionLogoutUrl = `${EVOLUTION_API_URL}/instance/logout/${instanceName}`;
  console.log(`[WhatsApp Handler Logout] Tentando logout na Evolution API: ${evolutionLogoutUrl}`);

  try {
    const evolutionResponse = await fetchWithTimeout(evolutionLogoutUrl, {
      method: 'DELETE',
      headers: { 'apikey': EVOLUTION_API_KEY }
    });

    const responseData = await evolutionResponse.json().catch(() => ({})); 
    console.log(`[WhatsApp Handler Logout] Resposta da API para logout ${instanceName}: Status ${evolutionResponse.status}`, responseData);

    if (evolutionResponse.ok || evolutionResponse.status === 404) {
      return res.status(200).json(responseData);
    } else {
      return res.status(evolutionResponse.status).json({ error: `Falha ao fazer logout na API`, details: responseData });
    }
  } catch (error) {
    console.error(`[WhatsApp Handler Logout] Erro de rede ao tentar logout ${instanceName}:`, error);
    return res.status(500).json({ error: 'Erro de comunicação com a API.', details: error.message });
  }
});

// Rota para obter o QR CODE de uma instância
router.get('/qrcode/:instanceName', requireAuth(), async (req, res) => {
  const { instanceName } = req.params;
  const { userId } = req.auth;

  console.log(`[WhatsApp Handler] Recebida requisição GET para /qrcode/${instanceName} por ${userId}`);

  const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.error('[WhatsApp Handler QR] EVOLUTION_API_URL ou EVOLUTION_API_KEY não configurados.');
    return res.status(500).json({ error: 'Configuração do servidor incompleta.' });
  }

  const expectedInstanceName = `nuvemx-whatsapp-${userId}`;
  if (instanceName !== expectedInstanceName) {
      console.warn(`[WhatsApp Handler QR] ${userId} tentando obter QR para ${instanceName} em vez de ${expectedInstanceName}.`);
      return res.status(403).json({ error: 'Não autorizado a obter QR code para esta instância.' });
  }
  
  try {
    const { data: instanceData, error: instanceError } = await supabase
      .from('InstanceUser')
      .select('clerk_user_id')
      .eq('instance_name', instanceName)
      .eq('clerk_user_id', userId)
      .single();
    
    if (instanceError || !instanceData) {
      console.warn(`[WhatsApp Handler QR] Instância ${instanceName} não no DB para ${userId}.`, instanceError);
      return res.status(404).json({ error: 'Registro da instância não encontrado. Crie a instância primeiro.' });
    }
    console.log(`[WhatsApp Handler QR] Usuário ${userId} autorizado para ${instanceName}.`);

  } catch (dbError) {
    console.error(`[WhatsApp Handler QR] Exceção ao verificar InstanceUser para ${instanceName}:`, dbError);
    return res.status(500).json({ error: 'Erro interno ao verificar registro.' });
  }

  const evolutionQrCodeUrl = `${EVOLUTION_API_URL}/instance/connect/${instanceName}`;
  console.log(`[WhatsApp Handler QR] Tentando obter QR Code da API: ${evolutionQrCodeUrl}`);

  try {
    const evolutionResponse = await fetchWithTimeout(evolutionQrCodeUrl, {
      method: 'GET',
      headers: { 'apikey': EVOLUTION_API_KEY }
    });

    const responseData = await evolutionResponse.json().catch(async () => {
      const textResponse = await evolutionResponse.text().catch(() => 'Corpo não lido.');
      console.warn(`[WhatsApp Handler QR] Resposta não JSON para ${instanceName}. Status: ${evolutionResponse.status}, Corpo: ${textResponse.substring(0, 500)}`);
      return { error: 'Resposta não JSON da API', details: textResponse.substring(0, 500), status: evolutionResponse.status };
    });
    
    console.log(`[WhatsApp Handler QR] Resposta da API para ${instanceName}: Status ${evolutionResponse.status}`);
    if (responseData.qrcode && responseData.qrcode.base64) {
        console.log(`[WhatsApp Handler QR] QR Code (base64) recebido para ${instanceName}.`);
    } else {
        console.warn(`[WhatsApp Handler QR] Resposta não continha qrcode.base64 para ${instanceName}.`, responseData);
    }

    if (evolutionResponse.ok && responseData.qrcode && responseData.qrcode.base64) {
      return res.status(200).json(responseData.qrcode);
    } else {
      const errorMessage = responseData.error || responseData.message || `Falha ao obter QR code da API`;
      const errorStatus = responseData.status || evolutionResponse.status || 500;
      return res.status(errorStatus).json({ error: errorMessage, details: responseData });
    }
  } catch (error) {
    console.error(`[WhatsApp Handler QR] Erro de rede ao obter QR para ${instanceName}:`, error);
    if (error.name === 'TimeoutError') {
      return res.status(504).json({ message: 'Gateway Timeout: A API da Evolution demorou muito para responder à consulta de QR code.' });
    }
    return res.status(500).json({ error: 'Erro de comunicação com a API.', details: error.message });
  }
});

// Rota para o FRONTEND VERIFICAR O STATUS DO QR CODE e obter os dados
router.get('/qr-status/:instanceName', requireAuth(), async (req, res) => {
  const clerkUserId = req.auth.userId;
  const { instanceName } = req.params;

  if (!instanceName) {
    return res.status(400).json({ success: false, message: 'O nome da instância é obrigatório.' });
  }

  try {
    const { data: instanceUser, error: userError } = await supabase
      .from('InstanceUser')
      .select('clerk_user_id, qr_code_base64, qr_pairing_code, qr_received_at, instance_status, last_status_reason')
      .eq('instance_name', instanceName)
      .eq('clerk_user_id', clerkUserId)
      .single();

    if (userError) {
      if (userError.code === 'PGRST116') {
        return res.status(404).json({ success: false, message: 'Instância não encontrada ou não pertence a este usuário.', status: 'NotFound' });
      }
      console.error(`[QR Status Handler] Erro ao buscar dados da instância ${instanceName} no Supabase:`, userError);
      return res.status(500).json({ success: false, message: 'Erro ao consultar dados da instância.', status: 'ErrorFetching' });
    }

    const responsePayload = {
        success: true,
        instanceName: instanceName,
        status: instanceUser.instance_status || 'Desconhecido',
        qrCodeBase64: instanceUser.qr_code_base64,
        pairingCode: instanceUser.qr_pairing_code,
        qrReceivedAt: instanceUser.qr_received_at,
        lastStatusReason: instanceUser.last_status_reason,
        _debug_supabase_instance_status: instanceUser.instance_status 
    };

    if (instanceUser.instance_status === 'QRCodeReady' && instanceUser.qr_code_base64) {
        console.log(`[QR Status Handler] QR Code pronto para ${instanceName}.`);
    } else if (!instanceUser.instance_status) {
        console.log(`[QR Status Handler] Informações de status ainda não disponíveis para ${instanceName}.`);
        responsePayload.message = 'Aguardando informações iniciais da instância.';
    } else {
        console.log(`[QR Status Handler] Status atual para ${instanceName}: ${instanceUser.instance_status}.`);
    }

    return res.status(200).json(responsePayload);

  } catch (error) {
    console.error(`[QR Status Handler] Exceção ao verificar status do QR para ${instanceName}:`, error);
    return res.status(500).json({ success: false, message: 'Erro interno ao verificar status do QR Code.', status: 'InternalError' });
  }
});

export default router; 