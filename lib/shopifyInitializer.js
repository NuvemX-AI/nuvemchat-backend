import { shopifyApi, LogSeverity, LATEST_API_VERSION } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node'; // Adaptador Node
import { SupabaseShopifySessionStorage } from './supabaseShopifySessionStorage.js';

// Carrega variáveis de .env para process.env.
// Certifique-se que seu arquivo .env está na raiz do diretório 'backend'
// Para ESM, dotenv/config é uma forma comum de carregar na inicialização do módulo.
// Se o .env não estiver na raiz de execução (geralmente onde está o package.json), 
// você precisará de uma configuração de path mais explícita.
// import dotenv from 'dotenv';
// import path from 'path';
// import { fileURLToPath } from 'url';
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
// dotenv.config({ path: path.resolve(__dirname, '../.env') }); // Se .env está um nível acima do 'lib'

let shopifyInstance = null;

export function getShopifyInstance() {
  if (shopifyInstance) {
    console.log('[ShopifyInstanceGetter] Retornando instância Shopify existente.');
    return shopifyInstance;
  }

  // As variáveis de ambiente devem ser carregadas pelo import 'dotenv/config' 
  // no index.js ou aqui, se este módulo for carregado antes do dotenv ter efeito global.
  // Para garantir, pode-se chamar explicitamente aqui ANTES de ler process.env
  // Mas o ideal é um único carregamento no entry point (index.js).

  const sessionStorageImpl = new SupabaseShopifySessionStorage();
  console.log('[ShopifyInstanceGetter] Tentando inicializar Shopify API...');
  console.log('[ShopifyInstanceGetter] process.env.SHOPIFY_API_KEY:', process.env.SHOPIFY_API_KEY ? 'Set' : 'Undefined');
  console.log('[ShopifyInstanceGetter] process.env.SHOPIFY_API_SECRET:', process.env.SHOPIFY_API_SECRET ? 'Set' : 'Undefined');
  console.log('[ShopifyInstanceGetter] process.env.SHOPIFY_SCOPES:', process.env.SHOPIFY_SCOPES);
  console.log('[ShopifyInstanceGetter] process.env.HOST:', process.env.HOST);
  console.log('[ShopifyInstanceGetter] Session Storage Instance Type:', sessionStorageImpl ? sessionStorageImpl.constructor.name : 'Undefined');

  const scopesString = process.env.SHOPIFY_SCOPES;
  let scopesArray = ['unauthenticated_write_checkouts']; // Fallback
  if (scopesString && typeof scopesString === 'string' && scopesString.trim() !== '') {
    scopesArray = scopesString.split(',').map(s => s.trim()).filter(s => s !== '');
    if (scopesArray.length === 0) {
      console.warn('[ShopifyInstanceGetter] SHOPIFY_SCOPES resultou em array vazio. Usando fallback.');
      scopesArray = ['unauthenticated_write_checkouts'];
    }
  } else {
    console.warn('[ShopifyInstanceGetter] SHOPIFY_SCOPES não definido/vazio. Usando fallback.');
  }
  console.log('[ShopifyInstanceGetter] Escopos a serem usados (array):', scopesArray);

  const appHost = process.env.HOST || 'http://localhost:3001'; // Fallback se HOST não estiver definido
  let parsedHostName;
  let parsedHostScheme = 'http'; // Default scheme

  try {
    const url = new URL(appHost);
    parsedHostName = url.hostname; // Ex: 'localhost'
    if (url.port && url.port !== '80' && url.port !== '443') {
      // Adiciona a porta apenas se não for padrão para o esquema
      parsedHostName = `${url.hostname}:${url.port}`; // Ex: 'localhost:3001'
    }
    parsedHostScheme = url.protocol.replace(':', ''); // Ex: 'http'
  } catch (e) {
    console.error(`[ShopifyInstanceGetter] Erro ao parsear HOST env var: '${appHost}'. Tentando extração manual.`, e);
    // Extração manual como fallback
    const hostStringForParsing = appHost.startsWith('http://') || appHost.startsWith('https://') 
      ? appHost.substring(appHost.indexOf('//') + 2) 
      : appHost; // Remove http:// ou https://
    
    const hostParts = hostStringForParsing.split(':');
    parsedHostName = hostParts[0]; // Ex: 'localhost'
    if (hostParts.length > 1) {
      parsedHostName = `${hostParts[0]}:${hostParts[1].split('/')[0]}`; // Ex: 'localhost:3001', removendo qualquer path
    }

    if (appHost.startsWith('https://')) {
      parsedHostScheme = 'https';
    } else {
      parsedHostScheme = 'http'; // Default para http se não for https
    }
    console.warn(`[ShopifyInstanceGetter] Fallback parsing result - hostName: '${parsedHostName}', hostScheme: '${parsedHostScheme}'. Verifique o formato de process.env.HOST.`);
  }
  
  console.log(`[ShopifyInstanceGetter] Usando hostName: '${parsedHostName}' e hostScheme: '${parsedHostScheme}' para Shopify API.`);

  shopifyInstance = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: scopesArray,
    hostName: parsedHostName,
    hostScheme: parsedHostScheme,
    apiVersion: LATEST_API_VERSION,
    isEmbeddedApp: false,
    sessionStorage: sessionStorageImpl,
    logger: {
      level: process.env.NODE_ENV === 'development' ? LogSeverity.Debug : LogSeverity.Info,
      timestamps: true,
    },
  });

  if (shopifyInstance && shopifyInstance.config) {
    console.log('[ShopifyInstanceGetter] shopifyInstance.config APÓS shopifyApi call (com hostName/Scheme corrigidos):', JSON.stringify(shopifyInstance.config, null, 2));
  } else {
    console.log('[ShopifyInstanceGetter] shopifyInstance ou .config é undefined APÓS shopifyApi call.');
  }

  if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
    console.error("CRITICAL: Shopify API Key or Secret is undefined.");
  } else {
    console.log("[ShopifyInstanceGetter] Shopify API client configured.");
  }
  return shopifyInstance;
} 