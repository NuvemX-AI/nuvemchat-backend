import crypto from 'crypto';
import { supabase } from './supabaseClient.js'; // Assuming supabaseClient.js is in the same lib folder or adjust path
import { getShopifyInstance } from './shopifyInitializer.js'; // Assuming shopifyInitializer.js is in the same lib folder

const shopify = getShopifyInstance();

// --- FUNÇÕES AUXILIARES DE CRIPTOGRAFIA PARA API KEY DA OPENAI ---
const CRYPTO_ALGORITHM = 'aes-256-cbc';
const CRYPTO_KEY_ENV_VAR = 'OPENAI_API_ENCRYPTION_KEY';

// Função para obter a chave de criptografia segura
export const getEncryptionKey = () => {
  const key = process.env[CRYPTO_KEY_ENV_VAR];
  if (!key || key.length !== 64) { // Chave deve ter 32 bytes (64 hex chars)
    console.error(`[Crypto] Chave de criptografia ${CRYPTO_KEY_ENV_VAR} não definida ou com tamanho inválido. Deve ter 64 caracteres hexadecimais.`);
    throw new Error('Chave de criptografia inválida ou não configurada.');
  }
  return Buffer.from(key, 'hex');
};

// Criptografar
export const encrypt = (text) => {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CRYPTO_ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
};

// Descriptografar
export const decrypt = (text) => {
  const key = getEncryptionKey();
  const parts = text.split(':');
  if (parts.length !== 2) {
    console.error('[Crypto] Formato de texto criptografado inválido. Esperado iv:encryptedData');
    throw new Error("Formato de texto criptografado inválido.");
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = parts[1];
  const decipher = crypto.createDecipheriv(CRYPTO_ALGORITHM, key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

// --- FUNÇÃO PARA OBTER SESSÃO SHOPIFY ---
export async function getShopifySession(shopDomain) {
  if (!shopDomain) {
    console.warn(
      "[Shopify Session] Tentativa de obter sessão sem shopDomain."
    );
    return null;
  }
  const normalizedShopDomain = shopDomain.replace(/^https?:\/\//, '').split('/')[0];

  try {
    const sessionId = shopify.session.getOfflineId(normalizedShopDomain);
    console.log(
      `[Shopify Session Util] Tentando carregar sessão offline para ${normalizedShopDomain} com ID: ${sessionId}`
    );
    const session = await shopify.config.sessionStorage.loadSession(sessionId);
    if (session) {
      console.log(
        `[Shopify Session Util] Sessão offline carregada com sucesso para ${normalizedShopDomain}.`
      );
      if (session.accessToken) {
         console.log(`[Shopify Session Util] Access token presente para ${normalizedShopDomain}.`);
        return session;
      } else {
        console.warn(
          `[Shopify Session Util] Sessão carregada para ${normalizedShopDomain}, mas SEM access token.`
        );
        return null; 
      }
    } else {
      console.warn(
        `[Shopify Session Util] Nenhuma sessão offline encontrada para ${normalizedShopDomain} com ID ${sessionId}.`
      );
      return null;
    }
  } catch (error) {
    console.error(
      `[Shopify Session Util] Erro ao carregar sessão Shopify para ${normalizedShopDomain}:`,
      error
    );
    return null;
  }
} 