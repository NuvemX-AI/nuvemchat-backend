import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const knowledgeBaseArticles = [
  {
    title: 'Como conectar sua loja Shopify à NuvemX.AI',
    content: `Para conectar sua loja Shopify à NuvemX.AI, siga estes passos:

1. **Acesse as Integrações**
   - Vá para Dashboard → Integrações
   - Clique em "Conectar Shopify"

2. **Autorize a Conexão**
   - Você será redirecionado para o Shopify
   - Faça login na sua conta Shopify
   - Autorize a aplicação NuvemX.AI

3. **Configurar Webhooks**
   - A NuvemX.AI configurará automaticamente os webhooks necessários
   - Isso permite que a IA acesse informações de produtos e pedidos

4. **Teste a Integração**
   - Volte ao dashboard
   - Teste algumas perguntas sobre seus produtos no Playground IA

**Problemas Comuns:**
- Erro de autorização: Verifique se você é o proprietário da loja
- Produtos não aparecem: Aguarde alguns minutos para sincronização
- Webhooks não funcionam: Verifique as configurações de firewall`,
    category: 'integracoes',
    tags: ['shopify', 'conexao', 'integracao', 'setup'],
    is_active: true
  },
  {
    title: 'Configurando o WhatsApp Business com Evolution API',
    content: `Para configurar o WhatsApp Business na NuvemX.AI:

1. **Preparar WhatsApp Business**
   - Tenha uma conta WhatsApp Business ativa
   - Anote o número de telefone que será usado

2. **Configurar Evolution API**
   - Vá para Dashboard → Integrações → WhatsApp
   - Clique em "Configurar Evolution API"
   - Insira a URL da sua Evolution API
   - Adicione a API Key

3. **Conectar Instância**
   - Clique em "Nova Instância"
   - Escaneie o QR Code com seu WhatsApp Business
   - Aguarde a confirmação de conexão

4. **Configurar Webhook**
   - A NuvemX.AI configurará automaticamente o webhook
   - Teste enviando uma mensagem para o número configurado

**Dicas Importantes:**
- Use apenas WhatsApp Business (não o pessoal)
- Mantenha a Evolution API sempre online
- Não desconecte o WhatsApp durante o uso`,
    category: 'integracoes',
    tags: ['whatsapp', 'evolution-api', 'business', 'webhook'],
    is_active: true
  },
  {
    title: 'Configurando sua chave OpenAI',
    content: `Para configurar sua chave da OpenAI:

1. **Obter Chave da OpenAI**
   - Acesse platform.openai.com
   - Faça login ou crie uma conta
   - Vá para API Keys
   - Clique em "Create new secret key"
   - Copie a chave (ela aparece apenas uma vez)

2. **Adicionar na NuvemX.AI**
   - Vá para Dashboard → Configurações IA
   - Cole sua chave OpenAI no campo apropriado
   - Clique em "Salvar e Testar"

3. **Configurar Modelo**
   - Escolha o modelo (recomendado: gpt-4o-mini)
   - Ajuste a temperatura (0.7 é um bom padrão)
   - Configure o limite de tokens

4. **Testar Configuração**
   - Use o Playground IA para testar
   - Faça algumas perguntas sobre seus produtos

**Problemas Comuns:**
- Chave inválida: Verifique se copiou corretamente
- Sem créditos: Adicione créditos na conta OpenAI
- Limite de rate: Aguarde alguns minutos entre testes`,
    category: 'configuracao',
    tags: ['openai', 'api-key', 'configuracao', 'ia'],
    is_active: true
  },
  {
    title: 'Entendendo os planos da NuvemX.AI',
    content: `A NuvemX.AI oferece diferentes planos para suas necessidades:

## Plano Core (Gratuito)
- 500 mensagens por mês
- Integração básica com Shopify
- Suporte por chat
- Ideal para testar a plataforma

## Plano Neural (R$ 99/mês)
- 5.000 mensagens por mês
- Todas as integrações disponíveis
- IA avançada com GPT-4
- Suporte prioritário
- Analytics detalhados

## Plano Nimbus (R$ 299/mês)
- 15.000 mensagens por mês
- Recursos premium
- Suporte telefônico
- Treinamento personalizado da IA
- API access

**Como fazer upgrade:**
1. Vá para Dashboard → Conta
2. Clique em "Gerenciar Assinatura"
3. Escolha o plano desejado
4. Complete o pagamento via Stripe

**Dúvidas sobre billing:**
- Faturamento mensal automático
- Cancelamento a qualquer momento
- Suporte para todas as formas de pagamento`,
    category: 'billing',
    tags: ['planos', 'upgrade', 'billing', 'pagamento'],
    is_active: true
  },
  {
    title: 'Minha IA não está respondendo - Troubleshooting',
    content: `Se sua IA não está respondendo, verifique:

## 1. Configurações da OpenAI
- Chave API válida e ativa
- Créditos disponíveis na conta OpenAI
- Modelo selecionado corretamente

## 2. Integrações
- Shopify conectado e funcionando
- WhatsApp com status "Conectado"
- Webhooks configurados corretamente

## 3. Configurações da IA
- Prompt personalizado configurado
- Temperatura entre 0.1 e 1.0
- Limite de tokens adequado (recomendado: 500-1000)

## 4. Verificações Técnicas
- Verifique o status da Evolution API
- Confirme se o WhatsApp Business está online
- Teste no Playground IA primeiro

## 5. Problemas Comuns
- **Demora nas respostas**: Normal, IA pode levar 5-15 segundos
- **Respostas genéricas**: Configure melhor o prompt personalizado
- **Erro de conexão**: Verifique sua internet e status dos serviços

**Ainda com problemas?**
Entre em contato conosco através deste chat de suporte!`,
    category: 'troubleshooting',
    tags: ['ia', 'nao-responde', 'problemas', 'debug'],
    is_active: true
  },
  {
    title: 'Como personalizar o comportamento da sua IA',
    content: `Para personalizar sua IA e melhorar as respostas:

## 1. Prompt Personalizado
- Vá para Configurações IA → Prompt Personalizado
- Descreva como a IA deve se comportar
- Inclua informações sobre sua empresa
- Defina o tom de voz (formal, casual, amigável)

## 2. Exemplo de Prompt Eficaz:
\`\`\`
Você é um assistente de vendas da [SUA EMPRESA].
Seja sempre educado e prestativo.
Foque em ajudar o cliente a encontrar produtos.
Quando não souber algo, seja honesto e ofereça ajuda humana.
Use emojis moderadamente para deixar a conversa mais amigável.
\`\`\`

## 3. Configurações Avançadas
- **Temperatura**: 0.7 para respostas equilibradas
- **Tokens**: 500-800 para respostas completas mas concisas
- **Modelo**: GPT-4o-mini para melhor custo-benefício

## 4. Dicas Importantes
- Teste sempre no Playground após mudanças
- Monitore as conversas para ajustar o comportamento
- Use linguagem clara e específica no prompt
- Evite prompts muito longos (máximo 500 palavras)

## 5. Exemplos por Segmento
- **Moda**: "Especialista em moda feminina, sempre sugira looks completos"
- **Eletrônicos**: "Técnico em eletrônicos, explique especificações de forma simples"
- **Casa**: "Consultor de decoração, ajude a criar ambientes harmoniosos"`,
    category: 'configuracao',
    tags: ['prompt', 'personalizacao', 'ia', 'comportamento'],
    is_active: true
  }
];

async function populateKnowledgeBase() {
  console.log('🚀 Iniciando população da base de conhecimento...');

  try {
    // Verificar se a tabela existe
    const { data: existingArticles, error: checkError } = await supabase
      .from('helpdesk_knowledge_base')
      .select('id')
      .limit(1);

    if (checkError) {
      console.error('❌ Erro ao verificar tabela:', checkError);
      console.log('⚠️  Execute primeiro a migração do schema do helpdesk');
      return;
    }

    // Limpar artigos existentes (opcional)
    console.log('🧹 Limpando artigos existentes...');
    await supabase
      .from('helpdesk_knowledge_base')
      .delete()
      .neq('id', 0); // Delete all

    // Inserir novos artigos
    console.log('📝 Inserindo artigos na base de conhecimento...');
    
    for (const article of knowledgeBaseArticles) {
      const { data, error } = await supabase
        .from('helpdesk_knowledge_base')
        .insert(article)
        .select()
        .single();

      if (error) {
        console.error(`❌ Erro ao inserir artigo "${article.title}":`, error);
      } else {
        console.log(`✅ Artigo inserido: "${article.title}" (ID: ${data.id})`);
      }
    }

    console.log('\n🎉 Base de conhecimento populada com sucesso!');
    console.log(`📊 Total de artigos: ${knowledgeBaseArticles.length}`);
    
    // Estatísticas por categoria
    const categoryStats = knowledgeBaseArticles.reduce((acc, article) => {
      acc[article.category] = (acc[article.category] || 0) + 1;
      return acc;
    }, {});
    
    console.log('\n📈 Artigos por categoria:');
    Object.entries(categoryStats).forEach(([category, count]) => {
      console.log(`  ${category}: ${count} artigos`);
    });

  } catch (error) {
    console.error('💥 Erro geral:', error);
  }
}

// Executar se chamado diretamente
populateKnowledgeBase()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('💥 Erro fatal:', error);
    process.exit(1);
  });

export { populateKnowledgeBase, knowledgeBaseArticles }; 