import { HumanInterventionService } from './humanInterventionService.js';

/**
 * Job para limpeza automática de intervenções expiradas
 */
export class InterventionCleanupJob {
  
  /**
   * Executa a limpeza de intervenções expiradas
   */
  static async runCleanup() {
    try {
      console.log('[INTERVENTION CLEANUP] Iniciando limpeza de intervenções expiradas...');
      
      const result = await HumanInterventionService.cleanupExpiredInterventions();
      
      if (result.cleaned > 0) {
        console.log(`[INTERVENTION CLEANUP] ✅ ${result.cleaned} intervenções expiradas foram finalizadas automaticamente`);
      } else {
        console.log('[INTERVENTION CLEANUP] ✅ Nenhuma intervenção expirada encontrada');
      }
      
      return result;
    } catch (error) {
      console.error('[INTERVENTION CLEANUP] ❌ Erro durante limpeza:', error);
      throw error;
    }
  }
  
  /**
   * Inicia o job de limpeza em intervalos regulares
   */
  static startCleanupJob(intervalMinutes = 1) {
    console.log(`[INTERVENTION CLEANUP] Iniciando job de limpeza (intervalo: ${intervalMinutes} minutos)`);
    
    // Executar imediatamente
    this.runCleanup();
    
    // Agendar execuções regulares
    setInterval(() => {
      this.runCleanup();
    }, intervalMinutes * 60 * 1000);
  }
}

// Iniciar o job automaticamente quando o módulo for carregado
InterventionCleanupJob.startCleanupJob(1); // Executar a cada 1 minuto 