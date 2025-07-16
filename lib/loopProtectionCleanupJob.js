import { AILoopProtection } from './aiLoopProtection.js';

/**
 * Job para limpeza automática de dados de proteção contra loops
 */
export class LoopProtectionCleanupJob {
  
  /**
   * Executa a limpeza de dados de proteção
   */
  static async runCleanup() {
    try {
      console.log('[LOOP PROTECTION CLEANUP] Iniciando limpeza de dados de proteção...');
      
      await AILoopProtection.cleanup();
      
      console.log('[LOOP PROTECTION CLEANUP] ✅ Limpeza concluída');
      
    } catch (error) {
      console.error('[LOOP PROTECTION CLEANUP] ❌ Erro durante limpeza:', error);
    }
  }
  
  /**
   * Inicia o job de limpeza em intervalos regulares
   */
  static startCleanupJob(intervalMinutes = 30) {
    console.log(`[LOOP PROTECTION CLEANUP] Iniciando job de limpeza (intervalo: ${intervalMinutes} minutos)`);
    
    // Executar imediatamente
    this.runCleanup();
    
    // Agendar execuções regulares
    setInterval(() => {
      this.runCleanup();
    }, intervalMinutes * 60 * 1000);
  }
}

// Iniciar o job automaticamente quando o módulo for carregado
LoopProtectionCleanupJob.startCleanupJob(30); // Executar a cada 30 minutos 