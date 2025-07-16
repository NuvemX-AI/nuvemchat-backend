import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

// Validação das chaves Stripe
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY;

if (!stripeSecretKey) {
  throw new Error('STRIPE_SECRET_KEY não configurada nas variáveis de ambiente');
}

if (!stripePublishableKey) {
  console.warn('STRIPE_PUBLISHABLE_KEY não configurada - apenas operações backend disponíveis');
}

// Configuração do cliente Stripe
const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2024-11-20.acacia', // Versão estável da API
  maxNetworkRetries: 3, // Retry automático em falhas de rede
  timeout: 10000, // 10 segundos de timeout
  telemetry: true, // Habilitar telemetria para debug
  appInfo: {
    name: 'NuvemX.AI',
    version: '1.0.0',
    url: 'https://nuvemx.ai'
  }
});

// Função simples para validar se as chaves estão configuradas
const validateStripeKeys = () => {
  return !!(stripeSecretKey && stripePublishableKey);
};

// Verificar conectividade com Stripe na inicialização
const validateStripeConnection = async () => {
  try {
    const account = await stripe.accounts.retrieve();
    console.log(`✅ Stripe conectado - Account ID: ${account.id}`);
    return true;
  } catch (error) {
    console.error('❌ Erro ao conectar com Stripe:', error.message);
    return false;
  }
};

// Exportar cliente e utilitários
export { stripe, stripePublishableKey, validateStripeKeys, validateStripeConnection };
export default stripe; 