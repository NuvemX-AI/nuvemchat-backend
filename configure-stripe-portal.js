import 'dotenv/config';
import { stripe } from './lib/stripeClient.js';

async function configureStripePortal() {
  try {
    console.log('🔧 Configurando Stripe Customer Portal...');
    
    // Verificar se já existe uma configuração padrão
    const existingConfigs = await stripe.billingPortal.configurations.list({
      is_default: true,
      limit: 1
    });
    
    if (existingConfigs.data.length > 0) {
      console.log('✅ Configuração padrão já existe:', existingConfigs.data[0].id);
      return existingConfigs.data[0];
    }
    
    // Criar nova configuração do portal
    const configuration = await stripe.billingPortal.configurations.create({
      features: {
        // Permitir visualizar histórico de faturas
        invoice_history: {
          enabled: true
        },
        
        // Permitir atualizar métodos de pagamento
        payment_method_update: {
          enabled: true
        },
        
        // Permitir atualizar informações do cliente
        customer_update: {
          enabled: true,
          allowed_updates: ['email', 'name', 'address', 'phone']
        },
        
        // Permitir cancelamento de assinatura
        subscription_cancel: {
          enabled: true,
          mode: 'at_period_end', // Cancelar no final do período
          cancellation_reason: {
            enabled: true,
            options: [
              'too_expensive',
              'missing_features', 
              'switched_service',
              'unused',
              'other'
            ]
          }
        }
        
        // Não incluir subscription_update por enquanto para evitar complexidade
      },
      
      business_profile: {
        headline: 'Gerencie sua assinatura NuvemX.AI',
        privacy_policy_url: process.env.FRONTEND_URL + '/privacidade',
        terms_of_service_url: process.env.FRONTEND_URL + '/termos'
      },
      
      default_return_url: process.env.FRONTEND_URL + '/dashboard'
    });
    
    console.log('✅ Portal configurado com sucesso!');
    console.log('📋 ID da configuração:', configuration.id);
    console.log('🔗 URL de retorno:', configuration.default_return_url);
    
    return configuration;
    
  } catch (error) {
    console.error('❌ Erro ao configurar portal:', error.message);
    throw error;
  }
}

// Executar automaticamente
configureStripePortal()
  .then(config => {
    console.log('\n🎉 Portal do Stripe configurado com sucesso!');
    console.log('Agora você pode usar o botão "Gerenciar assinatura" na página de conta.');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 Falha na configuração:', error);
    process.exit(1);
  });

export default configureStripePortal; 