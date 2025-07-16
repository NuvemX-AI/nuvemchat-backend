import { LATEST_API_VERSION } from '@shopify/shopify-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// Helper function to convert HTML to text (if needed, or ensure it's available)
// import { htmlToText } from 'html-to-text'; 
import { getTrackingInfo17Track } from './trackingService.js'; // IMPORTAR O SERVIÇO DE RASTREAMENTO
import { supabase } from './supabaseClient.js'; // IMPORTAR O CLIENTE SUPABASE

// FUNÇÃO PARA BUSCAR BASE DE CONHECIMENTO DO USUÁRIO
export async function fetchUserKnowledgeBase(userId) {
  if (!userId) {
    console.warn('[PromptBuilder] UserID não fornecido para buscar base de conhecimento.');
    return null;
  }

  try {
    console.log(`[PromptBuilder] Buscando base de conhecimento para usuário: ${userId}`);
    
    const { data: knowledgeBase, error } = await supabase
      .from('knowledge_base')
      .select('filename, content, created_at, updated_at')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        console.log(`[PromptBuilder] Nenhuma base de conhecimento encontrada para usuário: ${userId}`);
        return null;
      }
      console.error('[PromptBuilder] Erro ao buscar base de conhecimento:', error);
      return null;
    }

    if (!knowledgeBase || !knowledgeBase.content) {
      console.log(`[PromptBuilder] Base de conhecimento vazia para usuário: ${userId}`);
      return null;
    }

    console.log(`[PromptBuilder] Base de conhecimento encontrada: ${knowledgeBase.filename} (${knowledgeBase.content.length} caracteres)`);
    return knowledgeBase;

  } catch (error) {
    console.error('[PromptBuilder] Erro ao buscar base de conhecimento:', error);
    return null;
  }
}

async function fetchProductDetails(shopify, shopifySession) {
    let productTypesInfo = "";
    let productExamplesInfo = "";
    let uniqueProductTypesSet = new Set();
    let productExamplesArray = [];

    if (!shopifySession || !shopifySession.shop || !shopifySession.accessToken) {
        console.warn('[PromptBuilder] Shopify session, shop name, or accessToken is missing for fetching product details.');
        return { productTypesInfo, productExamplesInfo, uniqueProductTypesSet, productExamplesArray };
    }

    try {
        console.log(`[PromptBuilder] Buscando produtos da Shopify para a loja: ${shopifySession.shop}`);
        
        const client = new shopify.clients.Rest({
            session: shopifySession,
            apiVersion: LATEST_API_VERSION 
        });

        const productsResponse = await client.get({
            path: 'products',
            query: { limit: 20 }
        });

        if (productsResponse.body && productsResponse.body.products) {
            const products = productsResponse.body.products;
            console.log(`[PromptBuilder] ${products.length} produtos encontrados para ${shopifySession.shop}.`);

            products.forEach(product => {
                if (product.product_type) {
                    uniqueProductTypesSet.add(product.product_type.toLowerCase());
                }
                if (productExamplesArray.length < 3 && product.title) { // Limita a 3 exemplos
                    productExamplesArray.push({ 
                        title: product.title, 
                        handle: product.handle,
                        product_type: product.product_type && product.product_type.trim() !== '' ? product.product_type : 'Não especificado'
                    });
                }
            });

            if (uniqueProductTypesSet.size > 0) {
                productTypesInfo = `especializada em '${[...uniqueProductTypesSet].join("', '")}'`;
            }
            // productExamplesInfo é construído dinamicamente no prompt depois

        } else {
            console.warn('[PromptBuilder] Nenhum produto retornado ou formato de resposta inesperado da Shopify.');
        }

    } catch (error) {
        console.error(`[PromptBuilder] Erro ao buscar produtos da Shopify para a loja ${shopifySession.shop}:`, error.message);
        // Se for um erro de API, o objeto de erro pode ter mais detalhes
        if (error.response && error.response.body) {
            console.error('[PromptBuilder] Detalhes do erro da API Shopify:', JSON.stringify(error.response.body, null, 2));
        }
        // Não quebrar o prompt inteiro, apenas retornar informações vazias de produto
    }
    return { productTypesInfo, productExamplesInfo, uniqueProductTypesSet, productExamplesArray };
}

// NOVA FUNÇÃO PARA BUSCAR DETALHES DE UM PRODUTO ESPECÍFICO
export async function fetchSpecificProductDetails(shopify, shopifySession, productNameQuery) {
    if (!shopifySession || !shopifySession.shop || !shopifySession.accessToken) {
        console.warn('[PromptBuilder] Shopify session, shop name, or accessToken is missing for fetching specific product details.');
        return null;
    }
    if (!productNameQuery || productNameQuery.trim() === '') {
        console.warn('[PromptBuilder] productNameQuery está vazio. Não é possível buscar o produto.');
        return null;
    }

    try {
        console.log(`[PromptBuilder] Buscando produto específico na Shopify para a loja: ${shopifySession.shop}, query: "${productNameQuery}"`);
        
        const client = new shopify.clients.Rest({
            session: shopifySession,
            apiVersion: LATEST_API_VERSION 
        });

        // Busca produtos cujo título contenha a string de busca.
        // Solicita campos específicos para obter informações ricas.
        const response = await client.get({
            path: 'products',
            query: {
                title: productNameQuery, // A API da Shopify faz uma busca "contém" por padrão para o título.
                limit: 5, // Limita a 5 resultados para o caso de nomes genéricos. Idealmente, pegaríamos o mais relevante.
                fields: 'id,title,body_html,vendor,product_type,images,variants,handle' 
            }
        });

        if (response.body && response.body.products && response.body.products.length > 0) {
            const products = response.body.products;
            console.log(`[PromptBuilder] ${products.length} produto(s) encontrado(s) para a query "${productNameQuery}". Retornando o primeiro.`);
            
            // Por simplicidade, vamos retornar o primeiro produto encontrado.
            // Poderíamos adicionar lógica para escolher o mais relevante se houver múltiplos.
            const product = products[0];
            
            // Estruturar os dados do produto de forma útil
            const productDetails = {
                id: product.id,
                title: product.title,
                description: product.body_html, // Geralmente HTML, pode precisar de sanitização/conversão para texto.
                vendor: product.vendor,
                productType: product.product_type,
                url: `https://${shopifySession.shop}/products/${product.handle}`,
                images: product.images.map(img => ({ id: img.id, src: img.src, alt: img.alt })),
                variants: product.variants.map(v => ({
                    id: v.id,
                    title: v.title,
                    price: v.price,
                    sku: v.sku,
                    available: v.inventory_quantity > 0 || v.inventory_policy === 'continue', // Simplificado
                })),
                // Adicionar o preço da primeira variante como preço principal, se existir
                price: product.variants && product.variants.length > 0 ? product.variants[0].price : 'Não disponível'
            };
            
            // Pega a URL da primeira imagem como imagem principal
            productDetails.mainImageSrc = product.images && product.images.length > 0 ? product.images[0].src : null;

            return productDetails;
        } else {
            console.log(`[PromptBuilder] Nenhum produto encontrado para a query "${productNameQuery}" na loja ${shopifySession.shop}.`);
            return null;
        }

    } catch (error) {
        console.error(`[PromptBuilder] Erro ao buscar produto específico "${productNameQuery}" da Shopify para a loja ${shopifySession.shop}:`, error.message);
        if (error.response && error.response.body) {
            console.error('[PromptBuilder] Detalhes do erro da API Shopify:', JSON.stringify(error.response.body, null, 2));
        }
        return null;
    }
}

fetchSpecificProductDetails.description = {
    name: "fetchSpecificProductDetails",
    description: "Busca detalhes de um produto específico na loja Shopify usando uma query de nome do produto. Retorna informações como título, descrição, preço, variantes e link do produto.",
    parameters: {
        type: "object",
        properties: {
            productNameQuery: {
                type: "string",
                description: "O nome ou parte do nome do produto a ser buscado. Ex: \"Camiseta Estampada Azul\", \"Caneca Exclusiva\"."
            }
        },
        required: ["productNameQuery"]
    }
};

// NOVA FUNÇÃO PARA BUSCAR DETALHES DE UM PEDIDO ESPECÍFICO
export async function fetchOrderDetails(shopify, shopifySession, orderQuery) {
    if (!shopifySession || !shopifySession.shop || !shopifySession.accessToken) {
        console.warn('[PromptBuilder] Shopify session, shop name, or accessToken is missing for fetching order details.');
        return null;
    }
    if (!orderQuery || String(orderQuery).trim() === '') {
        console.warn('[PromptBuilder] orderQuery está vazio. Não é possível buscar o pedido.');
        return null;
    }

    const cleanedOrderQuery = String(orderQuery).replace(/#/g, '').trim();

    try {
        console.log(`[PromptBuilder] Buscando pedido na Shopify para a loja: ${shopifySession.shop}, query: "${cleanedOrderQuery}"`);
        
        const client = new shopify.clients.Rest({
            session: shopifySession,
            apiVersion: LATEST_API_VERSION 
        });

        const response = await client.get({
            path: 'orders',
            query: {
                name: cleanedOrderQuery,
                status: 'any',
                limit: 1 
            }
        });

        if (response.body && response.body.orders && response.body.orders.length > 0) {
            const order = response.body.orders[0];
            console.log(`[PromptBuilder] Pedido ID ${order.id} (name: ${order.name}) encontrado para a query "${cleanedOrderQuery}".`);
            
            const orderDetails = {
                id: order.id,
                name: order.name,
                email: order.email,
                phone: order.phone,
                shipping_address: order.shipping_address,
                financial_status: order.financial_status,
                fulfillment_status: order.fulfillment_status,
                total_price: order.total_price,
                currency: order.currency,
                line_items: order.line_items.map(item => ({
                    id: item.id,
                    title: item.title,
                    quantity: item.quantity,
                    price: item.price,
                    sku: item.sku
                })),
                tracking_url: order.fulfillments && order.fulfillments.length > 0 && order.fulfillments[0].tracking_url ? order.fulfillments[0].tracking_url : null,
                tracking_company: order.fulfillments && order.fulfillments.length > 0 && order.fulfillments[0].tracking_company ? order.fulfillments[0].tracking_company : null,
                tracking_number: order.fulfillments && order.fulfillments.length > 0 && order.fulfillments[0].tracking_number ? order.fulfillments[0].tracking_number : null,
            };
            return orderDetails;
        } else {
            console.log(`[PromptBuilder] Nenhum pedido encontrado para a query "${cleanedOrderQuery}" na loja ${shopifySession.shop}.`);
            return null;
        }

    } catch (error) {
        console.error(`[PromptBuilder] Erro ao buscar pedido "${cleanedOrderQuery}" da Shopify para ${shopifySession.shop}:`, error.message);
        if (error.response && error.response.body) {
            console.error('[PromptBuilder] Detalhes do erro da API Shopify (Pedidos):', JSON.stringify(error.response.body, null, 2));
        }
        return null;
    }
}

fetchOrderDetails.description = {
    name: "fetchOrderDetails",
    description: "Busca detalhes de um pedido específico na loja Shopify usando o número do pedido (como '#1234' ou '1234'). Retorna informações como status financeiro, status do fulfillment, itens, preços e informações de rastreamento se disponíveis.",
    parameters: {
        type: "object",
        properties: {
            orderQuery: {
                type: "string",
                description: "O número do pedido a ser buscado. Pode incluir o '#' ou ser apenas o número. Ex: \"#1001\", \"1002\"."
            }
        },
        required: ["orderQuery"]
    }
};

// NOVA FUNÇÃO PARA BUSCAR CONTEÚDO DE PÁGINA PELO HANDLE
export async function fetchShopifyPageContentByHandle(shopify, shopifySession, pageHandle) {
    if (!shopifySession || !shopifySession.shop || !shopifySession.accessToken) {
        console.warn('[PromptBuilder] Shopify session, shop name, or accessToken is missing for fetching page content by handle.');
        return null;
    }
    if (!pageHandle || typeof pageHandle !== 'string' || pageHandle.trim() === '') {
        console.warn('[PromptBuilder] pageHandle está vazio. Não é possível buscar o conteúdo da página.');
        return null;
    }

    try {
        console.log(`[PromptBuilder] Buscando conteúdo da página com handle '${pageHandle}' para a loja: ${shopifySession.shop}`);
        
        const client = new shopify.clients.Rest({ session: shopifySession });

        const response = await client.get({
            path: 'pages',
            query: {
                handle: pageHandle,
                fields: 'id,title,handle,body_html'
            }
        });

        if (response.body && Array.isArray(response.body.pages) && response.body.pages.length > 0) {
            const page = response.body.pages[0];
            // Verifica se o handle retornado é exatamente o mesmo que foi solicitado (case-sensitive)
            if (page.handle === pageHandle) {
                // const textContent = htmlToText(page.body_html, { // htmlToText não está importado globalmente aqui
                //     wordwrap: false,
                //     selectors: [
                //         { selector: 'script', format: 'skip' },
                //         { selector: 'style', format: 'skip' },
                //         { selector: 'nav', format: 'skip' },
                //         { selector: 'footer', format: 'skip' },
                //         { selector: 'a', options: { ignoreHref: true } }
                //     ]
                // });
                // Por enquanto, vamos retornar o body_html diretamente. A conversão para texto puro pode ser feita no handler se necessário.
                console.log(`[PromptBuilder] Conteúdo da página '${page.title}' (handle: ${pageHandle}) encontrado.`);
                return { title: page.title, handle: page.handle, content: page.body_html }; // Retornando HTML por enquanto
            } else {
                console.warn(`[PromptBuilder] Página encontrada pela API, mas o handle não corresponde exatamente. API handle: ${page.handle}, Requested handle: ${pageHandle}`);
                return null; // Ou poderia buscar mais resultados se a API permitisse busca mais flexível e filtrar aqui
            }
        } else if (response.body && Array.isArray(response.body.pages) && response.body.pages.length === 0) {
            console.log(`[PromptBuilder] Nenhuma página encontrada com o handle '${pageHandle}' para ${shopifySession.shop}.`);
            return null;
        } else {
            console.error(`[PromptBuilder] Resposta inesperada da API Shopify ao buscar página por handle '${pageHandle}' para ${shopifySession.shop}. Corpo:`, response.body);
            return null;
        }

    } catch (error) {
        console.error(`[PromptBuilder] Erro ao buscar conteúdo da página com handle '${pageHandle}' da Shopify para ${shopifySession.shop}:`, error.message);
        if (error.response && error.response.body) {
            console.error('[PromptBuilder] Detalhes do erro da API Shopify (Page Content):', JSON.stringify(error.response.body, null, 2));
        }
        return null;
    }
}

fetchShopifyPageContentByHandle.description = {
    name: "fetchShopifyPageContentByHandle",
    description: "Busca o conteúdo HTML de uma página específica da loja Shopify (como políticas de privacidade, termos de serviço, FAQs) usando o seu 'handle' (identificador único na URL, também conhecido como slug). Útil para responder perguntas sobre informações contidas nessas páginas.",
    parameters: {
        type: "object",
        properties: {
            pageHandle: {
                type: "string",
                description: "O 'handle' (slug) da página que se deseja buscar. Por exemplo, 'politica-de-privacidade', 'termos-de-servico'."
            }
        },
        required: ["pageHandle"]
    }
};

// NOVA FUNÇÃO PARA OBTER INFORMAÇÕES DE RASTREAMENTO
export async function getTrackingInformation(trackingNumber, carrierCode = null) {
    if (!trackingNumber || trackingNumber.trim() === '') {
        console.warn('[PromptBuilder] trackingNumber está vazio. Não é possível buscar informações de rastreamento.');
        return { error: "Número de rastreamento não fornecido." };
    }
    try {
        console.log(`[PromptBuilder] Buscando informações de rastreamento para: ${trackingNumber}, Carrier: ${carrierCode || 'auto-detect'}`);
        const trackingInfo = await getTrackingInfo17Track(trackingNumber, carrierCode);
        if (trackingInfo && trackingInfo.error) {
            // Se o serviço de rastreamento retornou um erro conhecido, repasse-o
            return { error: trackingInfo.error, details: trackingInfo.message || trackingInfo.details };
        }
        if (trackingInfo && trackingInfo.success === false) {
             return { error: "Falha ao obter informações de rastreamento.", details: trackingInfo.message || "Tente novamente mais tarde ou verifique o código." };
        }
        // Sucesso - trackingInfo já deve estar no formato esperado pela IA
        return trackingInfo; 
    } catch (error) {
        console.error(`[PromptBuilder] Erro ao buscar informações de rastreamento para ${trackingNumber}:`, error);
        return { error: "Erro interno ao processar sua solicitação de rastreamento.", details: error.message };
    }
}

getTrackingInformation.description = {
    name: "getTrackingInformation",
    description: "Obtém as informações de rastreamento mais recentes para um pacote usando seu código de rastreamento. Pode opcionalmente receber um código de transportadora.",
    parameters: {
        type: "object",
        properties: {
            trackingNumber: {
                type: "string",
                description: "O código de rastreamento do pacote (ex: SS987654321BR)."
            },
            carrierCode: {
                type: "string",
                description: "(Opcional) O código numérico da transportadora (ex: '3031' para Correios Brasil). Se omitido, o sistema tentará detectar automaticamente."
            }
        },
        required: ["trackingNumber"]
    }
};

// NOVA FUNÇÃO PARA GERAR LINKS DA LOJA SHOPIFY
export async function generateShopifyLink(shopifySession, linkType, handle, userId = null, conversationId = null) {
    if (!shopifySession || !shopifySession.shop) {
        console.warn('[PromptBuilder] Shopify session ou shop name está ausente. Não é possível gerar o link.');
        return { error: "Não foi possível determinar o domínio da loja para gerar o link." };
    }
    if (!linkType || !handle) {
        console.warn('[PromptBuilder] linkType ou handle estão ausentes. Não é possível gerar o link.');
        return { error: "Informações insuficientes (tipo de link ou identificador) para gerar o link." };
    }

    const shopDomain = shopifySession.shop; // ex: minha-loja.myshopify.com
    let generatedUrl = `https://${shopDomain}`;

    switch (linkType.toLowerCase()) {
        case 'product':
            generatedUrl += `/products/${handle}`;
            break;
        case 'collection':
            generatedUrl += `/collections/${handle}`;
            break;
        case 'page':
            generatedUrl += `/pages/${handle}`;
            break;
        default:
            console.warn(`[PromptBuilder] Tipo de link desconhecido: ${linkType}. Não foi possível gerar o link.`);
            return { error: `Tipo de link '${linkType}' não suportado.` };
    }
    
    // Gerar ID único para tracking de conversões
    const trackingId = `nuvemx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Adicionar UTM parameters para rastreamento
    const urlWithParams = new URL(generatedUrl);
    urlWithParams.searchParams.set('utm_source', 'nuvemx_ai');
    urlWithParams.searchParams.set('utm_medium', 'whatsapp_assistant');
    urlWithParams.searchParams.set('utm_campaign', 'ai_conversation');
    urlWithParams.searchParams.set('utm_content', `${linkType}_${handle}`);
    urlWithParams.searchParams.set('nuvemx_tracking', trackingId);
    
    // Salvar o link gerado no banco para tracking
    if (userId) {
        try {
            // Usar o cliente Supabase já importado
            const { error: insertError } = await supabase
                .from('ai_link_generations')
                .insert({
                    user_id: userId,
                    clerk_user_id: userId,
                    tracking_id: trackingId,
                    link_type: linkType,
                    handle: handle,
                    shop_domain: shopDomain,
                    generated_url: urlWithParams.toString(),
                    conversation_id: conversationId,
                    metadata: {
                        utm_source: 'nuvemx_ai',
                        utm_medium: 'whatsapp_assistant',
                        utm_campaign: 'ai_conversation',
                        utm_content: `${linkType}_${handle}`
                    }
                });
            
            if (insertError) {
                console.error('[PromptBuilder] Erro ao salvar link gerado:', insertError);
            } else {
                console.log(`[PromptBuilder] Link salvo no banco: ${trackingId}`);
            }
        } catch (error) {
            console.error('[PromptBuilder] Erro ao conectar com banco para salvar link:', error);
        }
    }
    
    // Log do tracking ID para debug
    console.log(`[PromptBuilder] Link gerado com tracking ID: ${trackingId} para ${linkType} '${handle}': ${urlWithParams.toString()}`);
    
    return { 
        url: urlWithParams.toString(),
        trackingId: trackingId,
        linkType: linkType,
        handle: handle
    };
}

generateShopifyLink.description = {
    name: "generateShopifyLink",
    description: "Gera um link completo para um produto, coleção ou página dentro da loja Shopify do cliente. Use somente quando o cliente explicitamente solicitar um link e após confirmar com ele. Sempre forneça o link completo gerado.",
    parameters: {
        type: "object",
        properties: {
            linkType: {
                type: "string",
                description: "O tipo de link a ser gerado. Valores válidos: 'product', 'collection', 'page'."
            },
            handle: {
                type: "string",
                description: "O 'handle' (identificador único na URL, slug) do produto, coleção ou página para o qual gerar o link."
            }
        },
        required: ["linkType", "handle"]
    }
};

export async function buildShopifySystemPrompt(params) {
        const { 
    aiName = "Luiza",
    shopName,
    shopify, // Instância da Shopify API
    shopifySession, // Sessão ativa da Shopify
    aiStyle = "amigável e prestativo",
    aiLanguage = "pt-br",
    orderDetailsContext = null, // Objeto com detalhes de um pedido específico para contexto inicial
    policyPageContent = null, // Conteúdo textual de UMA página de política (para compatibilidade/uso específico)
    availablePages = [], // NOVO: Lista de objetos { title: string, handle: string }
    knowledgeBaseContent = null // NOVO: Conteúdo da base de conhecimento do usuário
  } = params;

  // Determinar o nome da loja a ser usado na apresentação da IA.
  // O objetivo é que a IA se apresente como assistente DA LOJA DO CLIENTE.
  let displayShopName = shopName;
  if (shopName && shopName.toLowerCase() === 'nuvemx' && shopifySession && shopifySession.shop && !shopifySession.shop.toLowerCase().startsWith('nuvemx')) {
    // Se shopName é 'NuvemX' (genérico) E há uma sessão Shopify ativa com um nome de loja diferente,
    // prefira um nome derivado da sessão Shopify para a identidade da IA.
    // Ex: shopifySession.shop = "minha-loja.myshopify.com" -> "Minha Loja"
    const sessionShop = shopifySession.shop.split('.')[0];
    displayShopName = sessionShop.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  } else if (shopName && shopName.includes('.myshopify.com')) {
    // Se shopName ainda é um URL myshopify.com, limpa-o.
    const domainPart = shopName.split('.')[0];
    displayShopName = domainPart.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  const promptLines = [];

  promptLines.push(`Você é ${aiName}. Seu papel é atuar como uma especialista em atendimento ao cliente incrivelmente humana e prestativa para a loja online "${displayShopName}".`);
  promptLines.push(`Seu tom de comunicação deve ser consistentemente ${aiStyle}, como se você fosse um membro experiente e dedicado da equipe "${displayShopName}". Comunique-se em ${aiLanguage}.\n`);
  promptLines.push(`Seu principal objetivo é fazer com que cada cliente se sinta bem-vindo e totalmente assistido pela equipe da "${displayShopName}", resolvendo dúvidas sobre produtos, pedidos, políticas da loja e facilitando a experiência de compra de forma cordial, eficiente e, acima de tudo, natural.\n`);

  promptLines.push("Ao fornecer links para produtos, coleções ou páginas da loja, SEMPRE use o link completo que a ferramenta 'generateShopifyLink' te fornecer, incluindo todos os parâmetros de URL. Esses parâmetros são essenciais para nós e não devem ser omitidos ou alterados.");

  promptLines.push("PRINCÍPIOS DE INTERAÇÃO E IDENTIDADE (Para uma Atuação 100% Natural):");
  promptLines.push(`- Incorpore sua identidade: Você é ${aiName}, parte da equipe "${displayShopName}". Deixe isso transparecer no seu jeito de falar, não necessariamente em uma declaração formal. Ex: ao invés de "Eu sou um assistente virtual da Loja X", diga "Aqui é a ${aiName}, da Loja X! Em que posso ajudar?".`);
  promptLines.push(`- Foco total na "${displayShopName}": Suas informações e conversas são exclusivamente sobre a loja "${displayShopName}" e seus clientes.`);
  promptLines.push("- Empatia sempre: Mostre compreensão e paciência, especialmente se o cliente estiver confuso ou frustrado.");
  promptLines.push("- Linguagem positiva e proativa (quando apropriado): Tente antecipar necessidades sem ser invasiva. Se um cliente está interessado em um produto, você pode sutilmente mencionar um acessório complementar se fizer sentido.");
  promptLines.push("- Evite jargões técnicos: Explique tudo de forma simples e clara.");
  promptLines.push(`- Personalidade Consistente: Mantenha o tom ${aiStyle} em todas as interações. Se for um tom divertido, use emojis com moderação e adequação. Se for formal, mantenha a seriedade profissional, mas sempre cordial.`);
  promptLines.push(`- Clareza sobre suas capacidades (quando perguntado ou necessário): Se o cliente perguntar o que você pode fazer, explique de forma sucinta suas principais funções (ajudar com produtos, pedidos, rastreamento, políticas da loja ${displayShopName}).`);
  promptLines.push(`- Escuta Ativa e Concisão Inicial: Ao iniciar uma conversa ou responder a uma pergunta genérica (ex: "Gostaria de mais informações", "Oi", "Preciso de ajuda"), seja breve e faça uma pergunta aberta para que o cliente especifique o que precisa. Evite listar todas as suas capacidades ou opções de uma vez. Ex: se o cliente diz "Preciso de informações", responda com "Claro! Sobre o que exatamente você gostaria de saber?" ou "Com certeza! Me diga o que você procura e farei o meu melhor para ajudar.". O objetivo é entender a necessidade antes de oferecer soluções detalhadas.`);
  promptLines.push(`- Transparência sobre ser uma IA (SOMENTE se diretamente questionada): Se um cliente perguntar explicitamente se você é um robô ou uma IA, seja honesta de uma forma leve e focada na sua capacidade de ajudar: "Sou uma assistente virtual aqui da Loja ${displayShopName}, programada para te ajudar da melhor forma possível! 😊 Em que posso ser útil?". Não inicie essa informação.`);
  promptLines.push(`- Naturalidade acima de tudo: Evite frases que soem como um script ou que sejam excessivamente formais, a menos que o estilo (${aiStyle}) peça por isso. Busque fluidez e um tom de conversa real.`);
  promptLines.push(`- Proatividade contextual: Antecipe necessidades quando fizer sentido, como um bom vendedor ou atendente faria. Ex: "Notei que você se interessou pelo produto X. Sabia que temos uma oferta especial nele esta semana?" (Se for verdade e tiver essa info).\n`);

  promptLines.push("USO DAS FERRAMENTAS (Com Discrição e Naturalidade):");
  promptLines.push("- Use as ferramentas como se fossem seus superpoderes internos para buscar informações. Não anuncie que está 'usando uma ferramenta'. Apenas use a informação obtida para responder naturalmente.");
  promptLines.push("- Se uma ferramenta retornar um erro ou \"não encontrado\", traduza isso para uma linguagem humana e prestativa. Ex: \"Dei uma olhadinha aqui e parece que esse produto não está disponível no momento. Gostaria de ver algo similar?\" ou \"Não encontrei os detalhes desse pedido com o número informado. Poderia confirmar pra mim, por gentileza?\"");
  promptLines.push("- Não forneça URLs diretas ou links, a menos que seja um link de rastreamento explícito. Resuma a informação importante para o cliente.");
  promptLines.push("- Respostas concisas, mas completas: Vá direto ao ponto, mas sem perder a cordialidade e a clareza. Ao apresentar informações de uma ferramenta (como detalhes de um produto), foque nos aspectos mais relevantes para a pergunta do cliente. Evite sobrecarregá-lo com todos os detalhes de uma vez, a menos que ele peça.");
  promptLines.push("- Ao fornecer informações de uma ferramenta (ex: status de rastreamento), apresente os dados de forma clara e depois se coloque à disposição para dúvidas sobre *essas informações específicas* ou para ajudar com *outra questão*. Evite oferecer proativamente itens que você não pode gerar diretamente (como 'comprovantes em PDF'), a menos que seja uma funcionalidade explícita sua.");
  promptLines.push("- Honestidade com elegância: Se não souber algo, admita de forma natural e se ofereça para buscar ou direcionar, como \"Essa é uma ótima pergunta! Deixe-me verificar essa informação para você um instante.\" ou \"Sobre esse detalhe específico, o ideal seria confirmar com nossa equipe X. Posso te ajudar a encontrar o contato?\"");
  promptLines.push("- Clareza antes de agir: Se a pergunta do cliente for vaga demais para você escolher os parâmetros corretos para uma ferramenta (ex: nome do produto muito genérico, número do pedido incerto), peça educadamente por mais detalhes antes de tentar usar a ferramenta.");
  promptLines.push("- Lembre-se: Antes de responder, sempre considere se a pergunta do cliente pode ser melhor respondida com informações precisas de uma das suas ferramentas. Se sim, use-a. As informações obtidas diretamente pelas suas ferramentas são geralmente as mais atualizadas e precisas.\n");
  
  promptLines.push("### Ferramentas Disponíveis e Como Usá-las:");
  promptLines.push("- **`fetchSpecificProductDetails`**: Use esta ferramenta quando o cliente perguntar sobre um produto específico que você não conhece de imediato. Ela busca detalhes como nome, descrição, preço, imagens e variantes. Ex: Cliente: \"Vocês têm a Camiseta X?\" -> Use a ferramenta com `productNameQuery: \"Camiseta X\"`.");
  promptLines.push("- **`fetchOrderDetails`**: Use esta ferramenta se o cliente perguntar sobre o status de um pedido ou quiser informações sobre um pedido que já fez E FORNECER O NÚMERO DO PEDIDO. Ex: Cliente: \"Qual o status do meu pedido #12345?\" -> Use a ferramenta com `orderQuery: \"12345\"`.");
  promptLines.push("- **`getTrackingInformation`**: Use esta ferramenta se o cliente perguntar sobre o rastreamento de uma encomenda e fornecer um CÓDIGO DE RASTREAMENTO. Não use para status de pedido sem código. Ex: Cliente: \"Onde está meu pacote com código XYZ123BR?\" -> Use a ferramenta com `trackingNumber: \"XYZ123BR\"`.");
  promptLines.push("- **`fetchShopifyPageContentByHandle`**: Use esta ferramenta se o cliente perguntar sobre políticas da loja (trocas, devoluções, envio, privacidade, etc.) ou informações institucionais (sobre nós, contato). Primeiro, verifique se a informação está em `availablePages` (fornecido no contexto). Se sim, use o `handle` correspondente. Ex: Cliente: \"Qual a política de troca?\" -> Se `availablePages` contiver `{ title: 'Política de Trocas', handle: 'politica-de-trocas' }`, use a ferramenta com `handle: \"politica-de-trocas\"`.");
  promptLines.push(`- **\`generateShopifyLink\`**: Use esta ferramenta COM MUITA CAUTELA e APENAS se o cliente explicitamente SOLICITAR um link para um produto, coleção ou página da loja \"${displayShopName}\".`);
  promptLines.push("    - **Confirmação OBRIGATÓRIA:** ANTES de usar `generateShopifyLink`, SEMPRE pergunte ao cliente se ele gostaria do link. Ex: \"Posso te mandar o link direto para ele na nossa loja?\" ou \"Você gostaria do link para ver mais detalhes?\".");
  promptLines.push("    - **Contexto Necessário:** Para gerar o link, você precisará do \'handle\' do item (produto, coleção ou página).");
  promptLines.push("        - Para produtos, o `handle` pode ser obtido da ferramenta `fetchSpecificProductDetails` (se usada anteriormente na conversa).");
  promptLines.push("        - Para páginas, o `handle` pode ser obtido da ferramenta `fetchShopifyPageContentByHandle` ou da lista `availablePages`.");
  promptLines.push("        - Para coleções, se o cliente pedir um link para uma categoria de produtos e você souber o `handle` da coleção, pode usá-lo.");
  promptLines.push(`    - **NÃO GERE LINKS EXTERNOS:** Esta ferramenta SÓ DEVE gerar links para a loja \`https://${shopifySession.shop}\`. Se o cliente pedir um link externo, explique educadamente que você só pode fornecer links internos da loja.`);
  promptLines.push("    - **Priorize Informação Textual:** Sempre tente responder a dúvida do cliente textualmente primeiro. Ofereça o link como um complemento, se apropriado e após confirmação.");
  promptLines.push("    - Exemplo de uso: Se o cliente confirma que quer o link para o produto \'camiseta-x\', e você sabe que o handle é \'camiseta-x\', use a ferramenta com `linkType: \"product\"`, `handle: \"camiseta-x\"`.");
  promptLines.push("\nLembre-se: antes de usar qualquer ferramenta que acesse dados da loja, verifique se você tem uma `shopifySession` válida. Se não, informe que não pode acessar os dados no momento.\n");

  if (shopifySession && shopifySession.shop) {
    promptLines.push(`Você está conectado à loja Shopify: ${shopifySession.shop}.`);
    promptLines.push("Lembre-se que você também pode ajudar clientes a encontrar informações sobre seus pedidos ou o status de rastreamento usando as ferramentas apropriadas, caso eles forneçam um número de pedido ou consulta relevante.");
    } else {
    promptLines.push("Atenção: No momento, não há uma conexão ativa com a loja Shopify. Algumas funcionalidades podem estar limitadas.");
  }

  // BASE DE CONHECIMENTO PERSONALIZADA DO USUÁRIO
  if (knowledgeBaseContent && knowledgeBaseContent.trim().length > 0) {
    promptLines.push("\n=== BASE DE CONHECIMENTO PERSONALIZADA ===");
    promptLines.push("IMPORTANTE: Você tem acesso a informações específicas e personalizadas da loja que devem ser priorizadas em suas respostas.");
    promptLines.push("Use essas informações sempre que relevante para responder perguntas sobre produtos, serviços, políticas ou qualquer aspecto específico da loja.");
    promptLines.push("Esta base de conhecimento contém informações exclusivas e atualizadas que complementam as funcionalidades padrão.\n");
    promptLines.push("--- INÍCIO DA BASE DE CONHECIMENTO ---");
    promptLines.push(knowledgeBaseContent);
    promptLines.push("--- FIM DA BASE DE CONHECIMENTO ---\n");
    promptLines.push("LEMBRE-SE: Sempre que possível, utilize as informações desta base de conhecimento para fornecer respostas mais precisas e personalizadas aos clientes.\n");
  }

  // Informações sobre páginas de conteúdo disponíveis via tool
  if (availablePages && availablePages.length > 0) {
    promptLines.push("\nINFORMAÇÕES DE PÁGINAS DA LOJA:");
    promptLines.push("A loja possui as seguintes páginas informativas que você pode consultar usando a ferramenta 'fetchShopifyPageContentByHandle' com o 'handle' correspondente:");
    availablePages.forEach(page => {
      promptLines.push(`- Título: "${page.title}", Handle para ferramenta: "${page.handle}"`);
    });
    promptLines.push("Use a ferramenta 'fetchShopifyPageContentByHandle' para buscar o conteúdo dessas páginas quando a pergunta do cliente for sobre tópicos como políticas da loja (trocas, devoluções, envio), 'Sobre Nós', 'Contato', ou outros temas cobertos por essas páginas. Sempre priorize o conteúdo obtido pela ferramenta.\n");
  } else if (policyPageContent) { // Fallback para policyPageContent se availablePages não estiver populado mas policyPageContent sim
    promptLines.push(`\nCONTEÚDO DA POLÍTICA DA LOJA (Use esta informação se relevante e nenhuma página específica for consultada via ferramenta):\n${policyPageContent}\n`);
  }

    if (orderDetailsContext) {
    promptLines.push(`CONTEXTO INICIAL DO PEDIDO (Não mencione este bloco a menos que seja perguntado sobre este pedido específico):\nNúmero do Pedido: ${orderDetailsContext.orderNumber}\nStatus: ${orderDetailsContext.status}\nItens: ${orderDetailsContext.items.map(item => `${item.name} (Qtd: ${item.quantity})`).join(', ')}\nTotal: ${orderDetailsContext.totalPrice}\nPrazo de Entrega Estimado: ${orderDetailsContext.estimatedDelivery || 'Não informado'}\n`);
  }
  
  // Informações sobre produtos (obtidas anteriormente pela função fetchProductDetails)
  const { productTypesInfo, productExamplesArray } = await fetchProductDetails(shopify, shopifySession);
  
  if (productTypesInfo) {
    promptLines.push(`A loja "${displayShopName}" é ${productTypesInfo}.`);
  }
  if (productExamplesArray && productExamplesArray.length > 0) {
    promptLines.push("Alguns exemplos de produtos incluem:");
    productExamplesArray.forEach(p => {
      promptLines.push(`- ${p.title} (Tipo: ${p.product_type}, Handle: ${p.handle})`);
    });
    promptLines.push("Se o cliente perguntar sobre um produto específico, use a ferramenta 'fetchSpecificProductDetails' para obter detalhes completos.\n");
  }

  promptLines.push(`Lembre-se de ser ${aiStyle} e responder em ${aiLanguage}. Boa conversa!`);
  
  return promptLines.join('\n');
}

export function getSystemPromptRawTemplate() {
  return `Você é {{aiName}}. Seu papel é atuar como uma especialista em atendimento ao cliente incrivelmente humana e prestativa para a loja online "{{shopName}}".

Seu tom de comunicação deve ser consistentemente {{aiStyle}}, como se você fosse um membro experiente e dedicado da equipe "{{shopName}}". Comunique-se em {{aiLanguage}}.

Seu principal objetivo é fazer com que cada cliente se sinta bem-vindo e totalmente assistido pela equipe da "{{shopName}}", resolvendo dúvidas sobre produtos, pedidos, políticas da loja e facilitando a experiência de compra de forma cordial, eficiente e, acima de tudo, natural.

{{#if policyPageContent}}
POLÍTICAS DA LOJA:
{{policyPageContent}}
{{/if}}

{{#if productTypesInfo}}
A loja "{{shopName}}" é {{productTypesInfo}}.
{{/if}}

{{#if productExamplesInfo}}
{{productExamplesInfo}}
{{/if}}

Lembre-se de ser {{aiStyle}} e responder em {{aiLanguage}}. Boa conversa!`;
}