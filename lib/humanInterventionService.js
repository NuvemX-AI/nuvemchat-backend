import { supabase } from './supabaseClient.js';

/**
 * Serviço para gerenciar intervenções humanas nas conversas da IA
 */
export class HumanInterventionService {
  
  /**
   * Verifica se há intervenção humana ativa para uma conversa específica
   */
  static async checkActiveIntervention(clerkUserId, instanceName, remoteJid) {
    try {
      const { data, error } = await supabase
        .from('human_intervention')
        .select('*')
        .eq('clerk_user_id', clerkUserId)
        .eq('instance_name', instanceName)
        .eq('remote_jid', remoteJid)
        .eq('intervention_active', true)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('[HumanIntervention] Erro ao verificar intervenção:', error);
        return { hasIntervention: false, intervention: null };
      }

      if (!data) {
        return { hasIntervention: false, intervention: null };
      }

      // Verificar se a intervenção expirou (auto-resume)
      if (data.auto_resume_at && new Date() > new Date(data.auto_resume_at)) {
        console.log(`[HumanIntervention] Intervenção expirada para ${remoteJid}, resumindo IA automaticamente`);
        await this.endIntervention(clerkUserId, instanceName, remoteJid);
        return { hasIntervention: false, intervention: null };
      }

      return { hasIntervention: true, intervention: data };
    } catch (error) {
      console.error('[HumanIntervention] Erro ao verificar intervenção ativa:', error);
      return { hasIntervention: false, intervention: null };
    }
  }

  /**
   * Inicia uma intervenção humana para uma conversa específica
   * Se já existir uma intervenção ativa, renova o tempo
   */
  static async startIntervention(clerkUserId, instanceName, remoteJid, durationMinutes = 5, isAutomatic = false) {
    try {
      const now = new Date();
      const resumeTime = new Date(now.getTime() + (durationMinutes * 60 * 1000));
      
      // Verificar se já existe intervenção ativa
      const { data: existingIntervention } = await supabase
        .from('human_intervention')
        .select('*')
        .eq('clerk_user_id', clerkUserId)
        .eq('instance_name', instanceName)
        .eq('remote_jid', remoteJid)
        .eq('intervention_active', true)
        .single();

      if (existingIntervention) {
        // Renovar intervenção existente
        const { data: updatedIntervention, error: updateError } = await supabase
          .from('human_intervention')
          .update({
            auto_resume_at: resumeTime,
            updated_at: now
          })
          .eq('id', existingIntervention.id)
          .select()
          .single();

        if (updateError) {
          console.error('[HumanIntervention] Erro ao renovar intervenção:', updateError);
          return { success: false, error: updateError.message };
        }

        console.log(`[HumanIntervention] ${isAutomatic ? 'Intervenção automática' : 'Intervenção'} renovada para ${remoteJid} até ${resumeTime.toISOString()}`);
        return { 
          success: true, 
          data: updatedIntervention, 
          message: `Intervenção renovada por ${durationMinutes} minutos`,
          renewed: true
        };
      }

      // Criar nova intervenção
      const { data: newIntervention, error: insertError } = await supabase
        .from('human_intervention')
        .insert({
          clerk_user_id: clerkUserId,
          instance_name: instanceName,
          remote_jid: remoteJid,
          intervention_active: true,
          intervention_started_at: now,
          auto_resume_at: resumeTime,
          is_automatic: isAutomatic,
          created_at: now,
          updated_at: now
        })
        .select()
        .single();

      if (insertError) {
        console.error('[HumanIntervention] Erro ao criar intervenção:', insertError);
        return { success: false, error: insertError.message };
      }

      console.log(`[HumanIntervention] ${isAutomatic ? 'Intervenção automática' : 'Intervenção'} iniciada para ${remoteJid} até ${resumeTime.toISOString()}`);
      return { 
        success: true, 
        data: newIntervention, 
        message: `Intervenção iniciada por ${durationMinutes} minutos`,
        renewed: false
      };

    } catch (error) {
      console.error('[HumanIntervention] Erro ao iniciar intervenção:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Finaliza uma intervenção humana (retorna controle à IA)
   */
  static async endIntervention(clerkUserId, instanceName, remoteJid) {
    try {
      console.log(`[HumanIntervention] Finalizando intervenção para ${remoteJid}`);
      
      const { data, error } = await supabase
        .from('human_intervention')
        .update({
          intervention_active: false,
          intervention_ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('clerk_user_id', clerkUserId)
        .eq('instance_name', instanceName)
        .eq('remote_jid', remoteJid)
        .eq('intervention_active', true)
        .select();

      if (error) {
        console.error('[HumanIntervention] Erro ao finalizar intervenção:', error);
        return { success: false, error: error.message };
      }

      console.log(`[HumanIntervention] Intervenção finalizada com sucesso. Registros atualizados: ${data?.length || 0}`);
      return { success: true, interventionsEnded: data?.length || 0 };
    } catch (error) {
      console.error('[HumanIntervention] Erro ao finalizar intervenção:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Lista todas as intervenções ativas para um usuário
   */
  static async listActiveInterventions(clerkUserId) {
    try {
      const { data, error } = await supabase
        .from('human_intervention')
        .select('*')
        .eq('clerk_user_id', clerkUserId)
        .eq('intervention_active', true)
        .order('intervention_started_at', { ascending: false });

      if (error) {
        console.error('[HumanIntervention] Erro ao listar intervenções ativas:', error);
        return { success: false, error: error.message };
      }

      return { success: true, interventions: data || [] };
    } catch (error) {
      console.error('[HumanIntervention] Erro ao listar intervenções ativas:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Limpa intervenções expiradas automaticamente
   */
  static async cleanupExpiredInterventions() {
    try {
      console.log('[HumanIntervention] Limpando intervenções expiradas...');
      
      const { data, error } = await supabase
        .from('human_intervention')
        .update({
          intervention_active: false,
          intervention_ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('intervention_active', true)
        .lt('auto_resume_at', new Date().toISOString())
        .select();

      if (error) {
        console.error('[HumanIntervention] Erro ao limpar intervenções expiradas:', error);
        return { success: false, error: error.message };
      }

      if (data && data.length > 0) {
        console.log(`[HumanIntervention] ${data.length} intervenções expiradas foram finalizadas automaticamente`);
      }

      return { success: true, cleaned: data?.length || 0 };
    } catch (error) {
      console.error('[HumanIntervention] Erro ao limpar intervenções expiradas:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Detecta se uma mensagem é de um humano (baseado em padrões)
   * Esta função pode ser expandida com mais lógica de detecção
   */
  static detectHumanMessage(messageContent) {
    // Padrões que indicam intervenção humana
    const humanPatterns = [
      /^\[HUMANO\]/i,
      /^\[ATENDENTE\]/i,
      /^\[SUPORTE\]/i,
      /^\/humano/i,
      /^\/intervir/i,
      /^\/assumir/i
    ];

    return humanPatterns.some(pattern => pattern.test(messageContent));
  }

  /**
   * Detecta se uma mensagem indica fim de intervenção
   */
  static detectEndInterventionMessage(messageContent) {
    const endPatterns = [
      /^\[FIM\]/i,
      /^\[VOLTAR_IA\]/i,
      /^\/fim/i,
      /^\/voltar/i,
      /^\/ia/i
    ];

    return endPatterns.some(pattern => pattern.test(messageContent));
  }
}