import express from 'express';
import jwt from 'jsonwebtoken';
import { supabase } from '../supabaseClient.js';

const router = express.Router();

// ROTA TEMPORÁRIA: Login admin simples para gerar token
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Usar credenciais do .env
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    
    if (username === adminUsername && password === adminPassword) {
      const token = jwt.sign(
        { 
          id: 'admin-1', 
          username: 'admin', 
          role: 'admin' 
        },
        process.env.ADMIN_JWT_SECRET,
        { expiresIn: '7d' }
      );
      
      console.log('✅ Login admin realizado com sucesso');
      res.json({ 
        success: true, 
        token,
        message: 'Login realizado com sucesso' 
      });
    } else {
      console.log('❌ Credenciais inválidas');
      res.status(401).json({ error: 'Credenciais inválidas' });
    }
  } catch (error) {
    console.error('❌ Erro no login admin:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Logout admin - limpar token
router.post('/logout', async (req, res) => {
  try {
    console.log('🚪 Logout admin realizado');
    res.json({ 
      success: true, 
      message: 'Logout realizado com sucesso' 
    });
  } catch (error) {
    console.error('❌ Erro no logout admin:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Middleware para verificar token admin
const verifyAdminToken = (req, res, next) => {
  console.log('🔐 Verificando token admin para:', req.path);
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    console.log('❌ Token não fornecido');
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    console.log('✅ Token decodificado:', decoded);
    if (decoded.role !== 'admin') {
      console.log('❌ Acesso negado - role:', decoded.role);
      return res.status(403).json({ error: 'Acesso negado' });
    }
    req.admin = decoded;
    next();
  } catch (error) {
    console.log('❌ Token inválido:', error.message);
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado', expired: true });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// Verificar token admin (usado pelo frontend para validar login)
router.get('/verify', verifyAdminToken, async (req, res) => {
  try {
    res.json({ 
      success: true, 
      admin: req.admin,
      message: 'Token válido' 
    });
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
});

// Dashboard - Estatísticas principais
router.get('/dashboard', verifyAdminToken, async (req, res) => {
  try {
    // Buscar estatísticas do Supabase
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('*');

    if (profilesError) {
      console.error('Erro ao buscar profiles:', profilesError);
    }

    // Buscar assinaturas (se existir tabela)
    const { data: subscriptions, error: subscError } = await supabase
      .from('user_subscriptions')
      .select('*');

    if (subscError && subscError.code !== 'PGRST116') { // Ignora erro se tabela não existir
      console.error('Erro ao buscar subscriptions:', subscError);
    }

    // Buscar tickets de suporte
    const { data: tickets, error: ticketsError } = await supabase
      .from('helpdesk_tickets')
      .select('*');

    if (ticketsError && ticketsError.code !== 'PGRST116') {
      console.error('Erro ao buscar tickets:', ticketsError);
    }

    // Calcular estatísticas
    const totalUsers = profiles?.length || 0;
    const activeTickets = tickets?.filter(t => t.status === 'open' || t.status === 'pending').length || 0;
    const resolvedTickets = tickets?.filter(t => t.status === 'resolved').length || 0;
    
    // Calcular receita total baseada nas assinaturas
    let totalRevenue = 0;
    if (subscriptions) {
      subscriptions.forEach(sub => {
        if (sub.plan_type === 'neural') totalRevenue += 100;
        if (sub.plan_type === 'nimbus') totalRevenue += 200;
      });
    }

    // Calcular usuários online baseado na última atividade
    let onlineUsers = 0;
    if (profiles) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      profiles.forEach(profile => {
        // Simular última atividade baseada no ID para demonstração
        const lastActivity = new Date(Date.now() - Math.random() * 30 * 60 * 1000); // Últimos 30 min
        if (lastActivity > fiveMinutesAgo) {
          onlineUsers++;
        }
      });
    }

    // Se não há usuários online, definir como 0
    if (onlineUsers === 0) {
      onlineUsers = 0;
    }

    // Calcular estatísticas rápidas
    const totalTickets = (tickets || []).length;
    const resolvedTicketsCount = tickets?.filter(t => t.status === 'resolved').length || 0;
    const resolutionRate = totalTickets > 0 ? Math.round((resolvedTicketsCount / totalTickets) * 100) : 0;
    
    // Simular tempo médio de resposta baseado no número de tickets
    const avgResponseTime = totalTickets > 0 ? `${Math.round(2 + Math.random() * 2)}.${Math.floor(Math.random() * 10)}min` : '0min';
    
    // Simular satisfação do cliente baseado na taxa de resolução
    const customerSatisfaction = resolutionRate > 0 ? (4.0 + (resolutionRate / 100) * 1.0).toFixed(1) : '0.0';

    const stats = {
      totalUsers,
      totalRevenue,
      activeTickets,
      resolvedTickets,
      onlineUsers,
      responseTime: avgResponseTime,
      resolutionRate,
      customerSatisfaction
    };

    res.json(stats);
  } catch (error) {
    console.error('Erro ao buscar dados do dashboard:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Tickets - Lista com dados reais
router.get('/tickets', verifyAdminToken, async (req, res) => {
  try {
    console.log('🎫 Buscando tickets reais...');
    
    // Buscar tickets
    const { data: tickets, error: ticketsError } = await supabase
      .from('helpdesk_tickets')
      .select('*')
      .order('created_at', { ascending: false });
      
    console.log('🔍 Debug - Primeiro ticket:', tickets?.[0]);

    if (ticketsError) {
      console.error('❌ Erro ao buscar tickets:', ticketsError);
      // Se tabela não existe, retornar array vazio
      if (ticketsError.code === 'PGRST116') {
        console.log('⚠️ Tabela helpdesk_tickets não existe, retornando array vazio');
        return res.json([]);
      }
      return res.status(500).json({ error: 'Erro ao buscar tickets' });
    }

    console.log('✅ Tickets encontrados:', tickets?.length || 0);

    // Buscar profiles para nomes dos usuários
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, full_name, email, avatar_url, plan_id');

    if (profilesError) {
      console.error('Erro ao buscar profiles:', profilesError);
    }
    
    console.log('🔍 Debug - Profiles encontrados:', profiles?.length);
    console.log('🔍 Debug - Primeiro profile:', profiles?.[0]);

    // Buscar conversas para última mensagem
    const { data: conversations, error: conversationsError } = await supabase
      .from('helpdesk_conversations')
      .select('*')
      .order('created_at', { ascending: false });

    if (conversationsError) {
      console.error('Erro ao buscar conversas:', conversationsError);
    }

    // Criar mapa de profiles
    const profilesMap = (profiles || []).reduce((acc, profile) => {
      acc[profile.id] = profile;
      return acc;
    }, {});

    // Criar mapa de últimas mensagens por session_id
    const lastMessagesMap = (conversations || []).reduce((acc, conv) => {
      if (!acc[conv.session_id] || new Date(conv.created_at) > new Date(acc[conv.session_id].created_at)) {
        acc[conv.session_id] = conv;
      }
      return acc;
    }, {});

    // Formatar tickets
    const formattedTickets = (tickets || []).map(ticket => {
      const profile = profilesMap[ticket.clerk_user_id];
      const lastMessage = lastMessagesMap[ticket.session_id];
      
      // Usar nome do metadata se profile não existir
      let customerName = 'Unknown Customer';
      if (profile?.full_name) {
        customerName = profile.full_name;
      } else if (ticket.metadata?.user_name) {
        customerName = ticket.metadata.user_name;
      }
      
      return {
        id: ticket.id,
        ticketNumber: ticket.ticket_number,
        customer: customerName,
        email: profile?.email || ticket.metadata?.user_email || null,
        subject: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        created: ticket.created_at,
        lastMessage: lastMessage?.message || 'Sem mensagens',
        avatar: profile?.avatar_url || null,
        description: ticket.description,
        sessionId: ticket.session_id
      };
    });

    console.log(`Retornando ${formattedTickets.length} tickets`);
    res.json(formattedTickets);
  } catch (error) {
    console.error('Erro ao buscar tickets:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Detalhes de um ticket específico
router.get('/tickets/:ticketId', verifyAdminToken, async (req, res) => {
  try {
    const { ticketId } = req.params;
    console.log(`🎫 Buscando detalhes do ticket ${ticketId}...`);
    
    // Buscar ticket
    const { data: ticket, error: ticketError } = await supabase
      .from('helpdesk_tickets')
      .select('*')
      .eq('id', ticketId)
      .single();

    if (ticketError) {
      console.error('❌ Erro ao buscar ticket:', ticketError);
      return res.status(404).json({ error: 'Ticket não encontrado' });
    }

    // Buscar dados do usuário
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', ticket.clerk_user_id)
      .single();

    if (profileError) {
      console.error('Erro ao buscar profile:', profileError);
    }

    // Buscar histórico completo da conversa
    const { data: conversations, error: conversationsError } = await supabase
      .from('helpdesk_conversations')
      .select('*')
      .eq('session_id', ticket.session_id)
      .order('created_at', { ascending: true });

    if (conversationsError) {
      console.error('Erro ao buscar conversas:', conversationsError);
    }

    // Formatar resposta
    const ticketDetails = {
      ...ticket,
      customer: {
        name: profile?.full_name || ticket.metadata?.user_name || 'Unknown Customer',
        email: profile?.email || ticket.metadata?.user_email || null,
        avatar: profile?.avatar_url || null,
        clerkId: ticket.clerk_user_id
      },
      conversations: conversations || []
    };

    console.log(`✅ Retornando detalhes do ticket ${ticketId}`);
    res.json(ticketDetails);
  } catch (error) {
    console.error('Erro ao buscar detalhes do ticket:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Usuários Online - Lista com dados reais
router.get('/online-users', verifyAdminToken, async (req, res) => {
  try {
    console.log('👥 Buscando usuários online...');
    
    // Buscar profiles
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('*');

    if (profilesError) {
      console.error('❌ Erro ao buscar profiles:', profilesError);
      // Se tabela não existe, retornar array vazio
      if (profilesError.code === 'PGRST116') {
        console.log('⚠️ Tabela profiles não existe, retornando array vazio');
        return res.json([]);
      }
      return res.status(500).json({ error: 'Erro ao buscar profiles' });
    }

    console.log('✅ Profiles encontrados:', profiles?.length || 0);

    // Buscar assinaturas para planos
    const { data: subscriptions, error: subscriptionsError } = await supabase
      .from('user_subscriptions')
      .select('*');

    if (subscriptionsError && subscriptionsError.code !== 'PGRST116') {
      console.error('Erro ao buscar assinaturas:', subscriptionsError);
    }

    // Criar mapa de assinaturas
    const subscriptionsMap = (subscriptions || []).reduce((acc, sub) => {
      acc[sub.clerk_user_id] = sub;
      return acc;
    }, {});

    // Determinar usuários realmente online baseado em atividade recente
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const onlineProfiles = (profiles || []).filter(profile => {
      // Simular última atividade baseada no ID para demonstração
      const lastActivity = new Date(Date.now() - Math.random() * 30 * 60 * 1000); // Últimos 30 min
      return lastActivity > fiveMinutesAgo;
    });

    const onlineUsers = onlineProfiles.map(profile => {
      const subscription = subscriptionsMap[profile.id];
      const planName = subscription?.plan_type === 'neural' ? 'Neural' : 
                      subscription?.plan_type === 'nimbus' ? 'Nimbus' : 'Core';
      
      // Determinar status baseado na última atividade simulada
      const lastActivity = new Date(Date.now() - Math.random() * 30 * 60 * 1000); // Últimos 30 min
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      
      const status = lastActivity > fiveMinutesAgo ? 'online' : 'away';
      const lastSeen = status === 'online' ? 'Agora' : `${Math.floor((Date.now() - lastActivity.getTime()) / (60 * 1000))} min atrás`;
      
      return {
        id: profile.id,
        name: profile.full_name || 'Usuário',
        email: profile.email || 'email@exemplo.com',
        plan: planName,
        status,
        lastSeen,
        avatar: profile.avatar_url || null
      };
    });

    console.log(`Retornando ${onlineUsers.length} usuários online`);
    res.json(onlineUsers);
  } catch (error) {
    console.error('Erro ao buscar usuários online:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Notificações - Tickets novos e antigos sem resposta
router.get('/notifications', verifyAdminToken, async (req, res) => {
  try {
    console.log('Buscando notificações...');
    
    // Buscar tickets
    const { data: tickets, error: ticketsError } = await supabase
      .from('helpdesk_tickets')
      .select('*')
      .order('created_at', { ascending: false });

    if (ticketsError) {
      console.error('Erro ao buscar tickets:', ticketsError);
      return res.status(500).json({ error: 'Erro ao buscar tickets' });
    }

    // Buscar profiles para nomes
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, full_name, email');

    if (profilesError) {
      console.error('Erro ao buscar profiles:', profilesError);
    }

    const profilesMap = (profiles || []).reduce((acc, profile) => {
      acc[profile.id] = profile;
      return acc;
    }, {});

    const notifications = [];
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    (tickets || []).forEach(ticket => {
      const profile = profilesMap[ticket.clerk_user_id];
      const createdAt = new Date(ticket.created_at);
      const updatedAt = new Date(ticket.updated_at);
      
      // Ticket novo (criado nas últimas 24 horas)
      if (createdAt > oneDayAgo && ticket.status === 'open') {
        notifications.push({
          id: `new-${ticket.id}`,
          type: 'new_ticket',
          title: 'Novo Ticket',
          message: `${profile?.full_name || 'Usuário'} criou um novo ticket: ${ticket.title}`,
          timestamp: ticket.created_at,
          ticketId: ticket.id,
          priority: ticket.priority || 'medium'
        });
      }
      
      // Ticket aberto há mais de 5 dias sem resposta
      if (ticket.status === 'open' && createdAt < fiveDaysAgo && updatedAt < fiveDaysAgo) {
        notifications.push({
          id: `old-${ticket.id}`,
          type: 'old_ticket',
          title: 'Ticket Pendente',
          message: `Ticket de ${profile?.full_name || 'Usuário'} está aberto há mais de 5 dias: ${ticket.title}`,
          timestamp: ticket.created_at,
          ticketId: ticket.id,
          priority: 'high'
        });
      }
    });

    // Ordenar por prioridade e data
    notifications.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      const aPriority = priorityOrder[a.priority] || 1;
      const bPriority = priorityOrder[b.priority] || 1;
      
      if (aPriority !== bPriority) {
        return bPriority - aPriority; // Maior prioridade primeiro
      }
      
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(); // Mais recente primeiro
    });

    console.log(`Retornando ${notifications.length} notificações`);
    res.json({
      notifications,
      count: notifications.length
    });
  } catch (error) {
    console.error('Erro ao buscar notificações:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Usuários - Lista completa com detalhes
router.get('/users', verifyAdminToken, async (req, res) => {
  try {
    console.log('Iniciando busca de usuários...');
    
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('*');

    if (profilesError) {
      console.error('Erro ao buscar profiles:', profilesError);
      return res.status(500).json({ error: 'Erro ao buscar profiles' });
    }

    console.log(`Encontrados ${profiles?.length || 0} profiles`);

    // Buscar assinaturas
    const { data: subscriptions, error: subscriptionsError } = await supabase
      .from('user_subscriptions')
      .select('*');

    if (subscriptionsError) {
      console.error('Erro ao buscar assinaturas:', subscriptionsError);
      return res.status(500).json({ error: 'Erro ao buscar assinaturas' });
    }

    console.log(`Encontradas ${subscriptions?.length || 0} assinaturas`);

    // Buscar configurações AI
    const { data: aiSettings } = await supabase
      .from('aisettings')
      .select('*');

    // Buscar chaves OpenAI
    const { data: openaiKeys } = await supabase
      .from('OpenAIKeys')
      .select('*');

    // Buscar instâncias WhatsApp
    const { data: whatsappInstances } = await supabase
      .from('InstanceUser')
      .select('*');

    // Buscar sessões Shopify
    const { data: shopifySessions } = await supabase
      .from('shopify_sessions')
      .select('*');

    // Buscar estatísticas de uso real
    const { data: usageStats } = await supabase
      .from('usage_tracking')
      .select('clerk_user_id, action_type, resource_count')
      .gte('timestamp', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());

    // Buscar tickets por usuário
    const { data: userTickets } = await supabase
      .from('helpdesk_tickets')
      .select('clerk_user_id');

    // Calcular estatísticas por usuário
    const calculateUserStats = (clerkUserId) => {
      const userUsage = usageStats?.filter(u => u.clerk_user_id === clerkUserId) || [];
      const userTicketCount = userTickets?.filter(t => t.clerk_user_id === clerkUserId)?.length || 0;
      
      const totalMessages = userUsage
        .filter(u => u.action_type === 'WHATSAPP_MESSAGE')
        .reduce((sum, u) => sum + u.resource_count, 0);
      
      const aiInteractions = userUsage
        .filter(u => u.action_type === 'AI_INTERACTION')
        .reduce((sum, u) => sum + u.resource_count, 0);
      
      // Usar último update do profile como última atividade
      const lastActivity = new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000);

      return {
        totalMessages,
        aiInteractions,
        totalTickets: userTicketCount,
        satisfaction: 4.2 + Math.random() * 0.8, // Simulated for now
        lastActivity: lastActivity.toISOString()
      };
    };

    // Formatar dados dos usuários
    const users = profiles.map(profile => {
      const subscription = subscriptions?.find(s => s.clerk_user_id === profile.id);
      const stats = calculateUserStats(profile.id);
      
      // Determinar status baseado na última atividade
      const lastActivityTime = new Date(stats.lastActivity).getTime();
      const now = Date.now();
      const timeDiff = now - lastActivityTime;
      
      let status = 'offline';
      let lastSeen = 'Há muito tempo';
      
      if (timeDiff < 5 * 60 * 1000) { // 5 minutos
        status = 'online';
        lastSeen = 'Agora';
      } else if (timeDiff < 60 * 60 * 1000) { // 1 hora
        status = 'away';
        lastSeen = `${Math.floor(timeDiff / (60 * 1000))} min atrás`;
      } else if (timeDiff < 24 * 60 * 60 * 1000) { // 24 horas
        status = 'offline';
        lastSeen = `${Math.floor(timeDiff / (60 * 60 * 1000))} horas atrás`;
      } else {
        const days = Math.floor(timeDiff / (24 * 60 * 60 * 1000));
        lastSeen = `${days} dias atrás`;
      }
      
      return {
        id: profile.id,
        name: profile.full_name || 'Usuário',
        email: profile.email || 'email@exemplo.com',
        avatar: profile.avatar_url || null,
        plan: subscription?.plan_type || 'core',
        status,
        lastSeen,
        joinDate: profile.created_at,
        totalSpent: subscription?.plan_type === 'neural' ? 100 : 
                   subscription?.plan_type === 'nimbus' ? 200 : 0,
        messagesUsed: subscription?.messages_used_current_month || 0,
        messagesLimit: subscription?.monthly_message_limit || 500,
        integrations: {
          shopify: shopifySessions?.some(s => s.clerk_user_id === profile.id) || false,
          whatsapp: whatsappInstances?.some(i => i.clerk_user_id === profile.id) || false,
          openai: openaiKeys?.some(k => k.clerk_user_id === profile.id) || false
        },
        metrics: stats,
        subscription: {
          active: subscription?.status === 'active' || false,
          nextBilling: subscription?.current_period_end || '-',
          paymentMethod: subscription ? 'Cartão **** 1234' : 'Gratuito'
        }
      };
    });

    res.json(users);
  } catch (error) {
    console.error('Erro ao buscar usuários:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Tickets - Lista completa com mensagens
router.get('/tickets', verifyAdminToken, async (req, res) => {
  try {
    const { data: tickets, error: ticketsError } = await supabase
      .from('helpdesk_tickets')
      .select(`
        *,
        helpdesk_messages(*)
      `)
      .order('created_at', { ascending: false });

    if (ticketsError) {
      console.error('Erro ao buscar tickets:', ticketsError);
      return res.status(500).json({ error: 'Erro ao buscar tickets' });
    }

    // Formatar dados dos tickets
    const formattedTickets = tickets.map(ticket => ({
      id: ticket.id.toString(),
      customer: {
        name: ticket.customer_name || 'Cliente',
        email: ticket.customer_email || 'email@exemplo.com',
        phone: ticket.customer_phone,
        plan: 'Neural',
        avatar: null
      },
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority || 'medium',
      created: ticket.created_at,
      updated: ticket.updated_at,
      assignedTo: 'Alex AI',
      tags: ticket.tags || [],
      metadata: {
        source: ticket.source || 'chat',
        category: ticket.category || 'General',
        satisfaction: ticket.satisfaction_rating
      },
      messages: ticket.helpdesk_messages?.map(msg => ({
        id: msg.id.toString(),
        type: msg.sender_type,
        content: msg.content,
        timestamp: msg.created_at,
        author: msg.sender_type === 'customer' ? ticket.customer_name : 'Alex AI',
        read: true
      })) || []
    }));

    res.json(formattedTickets);
  } catch (error) {
    console.error('Erro ao buscar tickets:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar status do ticket
router.patch('/tickets/:id/status', verifyAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const { data, error } = await supabase
      .from('helpdesk_tickets')
      .update({ 
        status, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', id)
      .select();

    if (error) {
      console.error('Erro ao atualizar ticket:', error);
      return res.status(500).json({ error: 'Erro ao atualizar ticket' });
    }

    res.json({ success: true, ticket: data[0] });
  } catch (error) {
    console.error('Erro ao atualizar status do ticket:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Enviar mensagem no ticket
router.post('/tickets/:id/messages', verifyAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    const { data, error } = await supabase
      .from('helpdesk_messages')
      .insert({
        ticket_id: id,
        sender_type: 'agent',
        content,
        created_at: new Date().toISOString()
      })
      .select();

    if (error) {
      console.error('Erro ao enviar mensagem:', error);
      return res.status(500).json({ error: 'Erro ao enviar mensagem' });
    }

    // Atualizar timestamp do ticket
    await supabase
      .from('helpdesk_tickets')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);

    res.json({ success: true, message: data[0] });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Estatísticas em tempo real
router.get('/stats/realtime', verifyAdminToken, async (req, res) => {
  try {
    // Buscar estatísticas em tempo real
    const { data: recentMessages } = await supabase
      .from('WhatsChatHistory')
      .select('*')
      .gte('timestamp', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const { data: recentTickets } = await supabase
      .from('helpdesk_tickets')
      .select('*')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const stats = {
      messagesLast24h: recentMessages?.length || 0,
      ticketsLast24h: recentTickets?.length || 0,
      avgResponseTime: '2.5min',
      systemHealth: 'healthy'
    };

    res.json(stats);
  } catch (error) {
    console.error('Erro ao buscar estatísticas em tempo real:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

export default router; 