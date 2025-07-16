-- ====================================
-- SCHEMA DO HELPDESK - NuvemX.AI
-- ====================================

-- Tabela de sessões de suporte
CREATE TABLE IF NOT EXISTS helpdesk_sessions (
  id SERIAL PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'closed', 'transferred'
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tabela de tickets de suporte
CREATE TABLE IF NOT EXISTS helpdesk_tickets (
  id SERIAL PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  session_id INTEGER REFERENCES helpdesk_sessions(id),
  ticket_number TEXT UNIQUE NOT NULL, -- HD-2024-0001
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL, -- 'bug', 'question', 'feature', 'billing', 'integration', 'other'
  priority TEXT NOT NULL DEFAULT 'medium', -- 'low', 'medium', 'high', 'urgent'
  status TEXT NOT NULL DEFAULT 'open', -- 'open', 'in_progress', 'waiting_customer', 'resolved', 'closed'
  assigned_to TEXT, -- ID do agente (futuro)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  satisfaction_rating INTEGER, -- 1-5
  satisfaction_comment TEXT
);

-- Tabela de conversas do helpdesk
CREATE TABLE IF NOT EXISTS helpdesk_conversations (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES helpdesk_sessions(id),
  ticket_id INTEGER REFERENCES helpdesk_tickets(id),
  clerk_user_id TEXT NOT NULL,
  message_type TEXT NOT NULL, -- 'user', 'ai', 'agent', 'system'
  message TEXT NOT NULL,
  metadata JSONB, -- dados extras, tool calls, etc.
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabela da base de conhecimento
CREATE TABLE IF NOT EXISTS helpdesk_knowledge_base (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL, -- 'integracao', 'configuracao', 'billing', 'troubleshooting', 'faq'
  tags TEXT[],
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tabela de feedback do helpdesk
CREATE TABLE IF NOT EXISTS helpdesk_feedback (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES helpdesk_sessions(id),
  ticket_id INTEGER REFERENCES helpdesk_tickets(id),
  clerk_user_id TEXT NOT NULL,
  rating INTEGER NOT NULL, -- 1-5
  comment TEXT,
  feedback_type TEXT NOT NULL, -- 'ai_response', 'overall_experience', 'resolution'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_helpdesk_sessions_user ON helpdesk_sessions(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_sessions_status ON helpdesk_sessions(status);

CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_user ON helpdesk_tickets(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_status ON helpdesk_tickets(status);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_category ON helpdesk_tickets(category);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_priority ON helpdesk_tickets(priority);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_number ON helpdesk_tickets(ticket_number);

CREATE INDEX IF NOT EXISTS idx_helpdesk_conversations_session ON helpdesk_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_conversations_ticket ON helpdesk_conversations(ticket_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_conversations_user ON helpdesk_conversations(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_conversations_type ON helpdesk_conversations(message_type);

CREATE INDEX IF NOT EXISTS idx_helpdesk_knowledge_category ON helpdesk_knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_helpdesk_knowledge_active ON helpdesk_knowledge_base(is_active);

CREATE INDEX IF NOT EXISTS idx_helpdesk_feedback_session ON helpdesk_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_feedback_ticket ON helpdesk_feedback(ticket_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_feedback_user ON helpdesk_feedback(clerk_user_id);

-- ====================================
-- DADOS INICIAIS - BASE DE CONHECIMENTO
-- ====================================

INSERT INTO helpdesk_knowledge_base (title, content, category, tags) VALUES
-- INTEGRAÇÃO SHOPIFY
('Como conectar minha loja Shopify', 
'Para conectar sua loja Shopify ao NuvemX.AI:
1. Acesse o dashboard e vá em "Integrações"
2. Clique em "Conectar Shopify"
3. Insira o domínio da sua loja (ex: minhaloja.myshopify.com)
4. Autorize o aplicativo NuvemX.AI na sua conta Shopify
5. Aguarde a sincronização dos dados

Problemas comuns:
- Verifique se você tem permissões de administrador na loja
- Certifique-se de que o domínio está correto
- Tente desconectar e reconectar se houver erro', 
'integracao', 
ARRAY['shopify', 'conexao', 'loja', 'integracao']),

-- INTEGRAÇÃO WHATSAPP
('Configurar WhatsApp Business', 
'Para configurar o WhatsApp no NuvemX.AI:
1. Vá em "Integrações" > "WhatsApp"
2. Clique em "Conectar WhatsApp"
3. Escaneie o QR Code com seu WhatsApp Business
4. Aguarde a conexão ser estabelecida
5. Teste enviando uma mensagem

Dicas importantes:
- Use apenas WhatsApp Business
- Mantenha o celular conectado à internet
- Não faça logout do WhatsApp Web durante o uso
- A conexão pode levar até 2 minutos para ativar', 
'integracao', 
ARRAY['whatsapp', 'qr-code', 'business', 'conexao']),

-- INTEGRAÇÃO OPENAI
('Configurar chave da OpenAI', 
'Para configurar sua chave da OpenAI:
1. Acesse https://platform.openai.com/api-keys
2. Crie uma nova chave de API
3. Copie a chave (começa com sk-)
4. No NuvemX.AI, vá em "Integrações" > "OpenAI"
5. Cole sua chave e clique em "Salvar"

Importante:
- Mantenha sua chave segura
- Monitore seu uso na OpenAI
- Configure limites de gasto se necessário
- A chave é criptografada em nosso sistema', 
'integracao', 
ARRAY['openai', 'api-key', 'chave', 'ia']),

-- CONFIGURAÇÃO DA IA
('Personalizar minha IA de atendimento', 
'Para personalizar sua IA:
1. Vá em "Configurações da IA"
2. Defina o nome da sua IA
3. Escolha o tom de voz (formal, casual, amigável)
4. Selecione o idioma principal
5. Adicione informações específicas da sua loja
6. Teste no Playground antes de ativar

Dicas de personalização:
- Use um nome que combine com sua marca
- Mantenha o tom consistente com sua comunicação
- Adicione informações sobre políticas de troca
- Teste diferentes configurações no Playground', 
'configuracao', 
ARRAY['ia', 'personalização', 'tom', 'configuracao']),

-- BILLING E PLANOS
('Diferenças entre os planos', 
'NuvemX.AI oferece 3 planos:

CORE (Gratuito):
- 500 mensagens/mês
- 1 integração WhatsApp
- IA básica
- Suporte por email

NEURAL (R$ 100/mês):
- 5.000 mensagens/mês
- Configuração personalizada da IA
- Analytics básicos
- Suporte por chat

NIMBUS (R$ 200/mês):
- 15.000 mensagens/mês
- Analytics avançados
- Histórico completo
- Suporte prioritário
- API de integração

Você pode fazer upgrade/downgrade a qualquer momento.', 
'billing', 
ARRAY['planos', 'preco', 'upgrade', 'mensagens']),

-- TROUBLESHOOTING
('Minha IA não está respondendo', 
'Se sua IA não está respondendo:

1. Verifique as integrações:
   - Shopify conectado?
   - OpenAI configurado?
   - WhatsApp ativo?

2. Verifique seu plano:
   - Ainda tem mensagens disponíveis?
   - Plano está ativo?

3. Teste no Playground:
   - IA responde no Playground?
   - Mensagens de erro?

4. Verifique configurações:
   - IA está ativada?
   - Configurações salvas?

Se o problema persistir, entre em contato conosco.', 
'troubleshooting', 
ARRAY['ia', 'nao-responde', 'problema', 'debug']),

-- FAQ GERAL
('Como funciona o sistema de mensagens', 
'O NuvemX.AI conta mensagens da seguinte forma:

- Cada resposta da IA = 1 mensagem
- Mensagens do cliente não contam
- Limite é mensal (renova todo mês)
- Mensagens do Playground não contam no limite

Dicas para economizar mensagens:
- Configure a IA para ser mais direta
- Use o Playground para testes
- Monitore o uso no dashboard
- Considere upgrade se necessário

Você pode acompanhar seu uso em tempo real no dashboard.', 
'faq', 
ARRAY['mensagens', 'limite', 'uso', 'economia']),

('Segurança e privacidade dos dados', 
'Sua segurança é nossa prioridade:

DADOS CRIPTOGRAFADOS:
- Chaves de API criptografadas
- Conversas protegidas
- Dados da loja seguros

CONFORMIDADE:
- LGPD compliant
- Servidores no Brasil
- Backup automático
- Monitoramento 24/7

ACESSO:
- Apenas você tem acesso aos seus dados
- Não compartilhamos informações
- Você pode exportar ou deletar dados
- Suporte técnico com permissão limitada

Para mais informações, consulte nossa Política de Privacidade.', 
'faq', 
ARRAY['seguranca', 'privacidade', 'lgpd', 'dados']);

-- ====================================
-- COMENTÁRIOS FINAIS
-- ====================================

-- Este schema cria toda a estrutura necessária para o sistema de helpdesk
-- Inclui sessões, tickets, conversas, base de conhecimento e feedback
-- Os índices otimizam as consultas mais frequentes
-- A base de conhecimento inicial cobre os principais tópicos de suporte 