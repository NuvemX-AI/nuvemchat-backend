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
  category TEXT NOT NULL, -- 'bug', 'question', 'feature', 'billing', 'integration'
  priority TEXT NOT NULL DEFAULT 'medium', -- 'low', 'medium', 'high', 'urgent'
  status TEXT NOT NULL DEFAULT 'open', -- 'open', 'in_progress', 'resolved', 'closed'
  assigned_to TEXT, -- clerk_user_id do agente
  satisfaction_rating INTEGER CHECK (satisfaction_rating >= 1 AND satisfaction_rating <= 5),
  satisfaction_comment TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

-- Tabela de conversas do helpdesk
CREATE TABLE IF NOT EXISTS helpdesk_conversations (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES helpdesk_sessions(id),
  ticket_id INTEGER REFERENCES helpdesk_tickets(id),
  clerk_user_id TEXT NOT NULL,
  message_type TEXT NOT NULL, -- 'user', 'ai', 'agent', 'system'
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabela de base de conhecimento
CREATE TABLE IF NOT EXISTS helpdesk_knowledge_base (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL, -- 'integration', 'billing', 'technical', 'general'
  tags TEXT[] DEFAULT '{}',
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
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  feedback_type TEXT DEFAULT 'overall_experience', -- 'ai_quality', 'response_time', 'overall_experience'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_helpdesk_sessions_user ON helpdesk_sessions(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_sessions_status ON helpdesk_sessions(status);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_user ON helpdesk_tickets(clerk_user_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_status ON helpdesk_tickets(status);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_number ON helpdesk_tickets(ticket_number);
CREATE INDEX IF NOT EXISTS idx_helpdesk_conversations_session ON helpdesk_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_conversations_ticket ON helpdesk_conversations(ticket_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_knowledge_category ON helpdesk_knowledge_base(category);
CREATE INDEX IF NOT EXISTS idx_helpdesk_knowledge_active ON helpdesk_knowledge_base(is_active);

-- Trigger para atualizar updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_helpdesk_sessions_updated_at BEFORE UPDATE ON helpdesk_sessions FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_helpdesk_tickets_updated_at BEFORE UPDATE ON helpdesk_tickets FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
CREATE TRIGGER update_helpdesk_knowledge_updated_at BEFORE UPDATE ON helpdesk_knowledge_base FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column(); 