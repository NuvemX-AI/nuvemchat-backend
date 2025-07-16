import OpenAI from 'openai';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Serviço para transcrição de áudios usando OpenAI Whisper
 */
export class AudioTranscriptionService {
  
  /**
   * Inicializa o cliente OpenAI para transcrição
   */
  static initOpenAI(apiKey) {
    if (!apiKey) {
      throw new Error('API Key da OpenAI não fornecida para transcrição');
    }
    
    return new OpenAI({
      apiKey: apiKey
    });
  }

  /**
   * Verifica se uma mensagem contém áudio
   */
  static isAudioMessage(messageData) {
    try {
      const message = messageData?.message || messageData;
      
      // Verificar diferentes tipos de mensagem de áudio
      return !!(
        message?.audioMessage || 
        message?.voiceMessage ||
        message?.pttMessage ||
        (message?.messageType === 'audioMessage') ||
        (message?.messageType === 'voiceMessage') ||
        (message?.messageType === 'pttMessage')
      );
    } catch (error) {
      console.error('[AudioTranscription] Erro ao verificar se é áudio:', error);
      return false;
    }
  }

  /**
   * Extrai a URL do áudio da mensagem
   */
  static extractAudioUrl(messageData) {
    try {
      const message = messageData?.message || messageData;
      
      // Tentar diferentes estruturas de áudio
      let audioUrl = null;
      
      if (message?.audioMessage?.url) {
        audioUrl = message.audioMessage.url;
      } else if (message?.voiceMessage?.url) {
        audioUrl = message.voiceMessage.url;
      } else if (message?.pttMessage?.url) {
        audioUrl = message.pttMessage.url;
      } else if (message?.audioMessage?.directPath) {
        // Construir URL baseada no directPath
        audioUrl = `${process.env.EVOLUTION_API_URL}/instance/media/${messageData?.key?.remoteJid}/${message.audioMessage.directPath}`;
      } else if (message?.voiceMessage?.directPath) {
        audioUrl = `${process.env.EVOLUTION_API_URL}/instance/media/${messageData?.key?.remoteJid}/${message.voiceMessage.directPath}`;
      }
      
      console.log('[AudioTranscription] URL do áudio extraída:', audioUrl);
      return audioUrl;
    } catch (error) {
      console.error('[AudioTranscription] Erro ao extrair URL do áudio:', error);
      return null;
    }
  }

  /**
   * Baixa um arquivo de áudio de uma URL
   */
  static async downloadAudio(audioUrl, filename) {
    try {
      console.log(`[AudioTranscription] Baixando áudio de: ${audioUrl}`);
      
      const response = await fetch(audioUrl, {
        headers: {
          'apikey': process.env.EVOLUTION_API_KEY
        }
      });
      
      if (!response.ok) {
        throw new Error(`Erro HTTP ${response.status}: ${response.statusText}`);
      }
      
      const tempDir = path.join(__dirname, '..', 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const filePath = path.join(tempDir, filename);
      const buffer = await response.buffer();
      
      fs.writeFileSync(filePath, buffer);
      console.log(`[AudioTranscription] Áudio baixado para: ${filePath}`);
      
      return filePath;
    } catch (error) {
      console.error('[AudioTranscription] Erro ao baixar áudio:', error);
      throw error;
    }
  }

  /**
   * Converte áudio OGG para MP3 usando ffmpeg
   */
  static async convertOggToMp3(inputPath) {
    try {
      const outputPath = inputPath.replace('.ogg', '.mp3');
      
      console.log(`[AudioTranscription] Convertendo ${inputPath} para ${outputPath}`);
      
      // Comando ffmpeg para converter OGG para MP3
      const command = `ffmpeg -i "${inputPath}" -acodec mp3 -y "${outputPath}"`;
      
      await execAsync(command);
      
      console.log(`[AudioTranscription] Conversão concluída: ${outputPath}`);
      
      // Remover arquivo OGG original
      fs.unlinkSync(inputPath);
      
      return outputPath;
    } catch (error) {
      console.error(`[AudioTranscription] Erro na conversão OGG->MP3:`, error.message);
      throw error;
    }
  }

  /**
   * Transcreve o áudio usando OpenAI Whisper
   */
  static async transcribeAudio(audioPath, openaiApiKey) {
    try {
      // Inicializar cliente OpenAI para cada tentativa
      const openaiClient = this.initOpenAI(openaiApiKey);
      
      console.log(`[AudioTranscription] Transcrevendo áudio: ${audioPath}`);
      
      // Estratégia 1: Tentar com arquivo original (.ogg)
      try {
        const audioFile = fs.createReadStream(audioPath);
        
        const response = await openaiClient.audio.transcriptions.create({
          file: audioFile,
          model: 'whisper-1',
          language: 'pt', // Português
          response_format: 'text'
        });

        console.log(`[AudioTranscription] Transcrição bem-sucedida (original): "${response}"`);
        return response;
      } catch (originalError) {
        console.log(`[AudioTranscription] Falha com arquivo original:`, originalError.message);
      }
      
      // Estratégia 2: Renomear arquivo OGG para WEBM (formato similar)
      if (audioPath.endsWith('.ogg')) {
        try {
          const webmPath = audioPath.replace('.ogg', '.webm');
          fs.copyFileSync(audioPath, webmPath);
          
          console.log(`[AudioTranscription] Tentando como WEBM: ${webmPath}`);
          
          const audioFile = fs.createReadStream(webmPath);
          
          const response = await openaiClient.audio.transcriptions.create({
            file: audioFile,
            model: 'whisper-1',
            language: 'pt',
            response_format: 'text'
          });

          console.log(`[AudioTranscription] Transcrição bem-sucedida (WEBM): "${response}"`);
          
          // Limpar arquivo WEBM temporário
          this.cleanupTempFile(webmPath);
          
          return response;
        } catch (webmError) {
          console.log(`[AudioTranscription] Falha com WEBM:`, webmError.message);
          // Tentar limpar arquivo WEBM se foi criado
          const webmPath = audioPath.replace('.ogg', '.webm');
          this.cleanupTempFile(webmPath);
        }
      }
      
      // Estratégia 3: Tentar como WAV
      if (audioPath.endsWith('.ogg')) {
        try {
          const wavPath = audioPath.replace('.ogg', '.wav');
          fs.copyFileSync(audioPath, wavPath);
          
          console.log(`[AudioTranscription] Tentando como WAV: ${wavPath}`);
          
          const audioFile = fs.createReadStream(wavPath);
          
          const response = await openaiClient.audio.transcriptions.create({
            file: audioFile,
            model: 'whisper-1',
            language: 'pt',
            response_format: 'text'
          });

          console.log(`[AudioTranscription] Transcrição bem-sucedida (WAV): "${response}"`);
          
          // Limpar arquivo WAV temporário
          this.cleanupTempFile(wavPath);
          
          return response;
        } catch (wavError) {
          console.log(`[AudioTranscription] Falha com WAV:`, wavError.message);
          // Tentar limpar arquivo WAV se foi criado
          const wavPath = audioPath.replace('.ogg', '.wav');
          this.cleanupTempFile(wavPath);
        }
      }
      
      // Se todas as estratégias falharam, lançar o erro original
      throw new Error('Formato de áudio não suportado pelo OpenAI Whisper');
      
    } catch (error) {
      console.error(`[AudioTranscription] Erro na transcrição:`, error);
      throw error;
    }
  }

  /**
   * Remove arquivo temporário
   */
  static cleanupTempFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[AudioTranscription] Arquivo temporário removido: ${filePath}`);
      }
    } catch (error) {
      console.error('[AudioTranscription] Erro ao remover arquivo temporário:', error);
    }
  }

  /**
   * Processa uma mensagem de áudio completa
   */
  static async processAudioMessage(audioUrl, openaiApiKey, messageId) {
    let tempFilePath = null;
    
    try {
      // Gerar nome único para o arquivo
      const timestamp = Date.now();
      const filename = `audio_${messageId}_${timestamp}.ogg`;
      
      // Baixar áudio
      tempFilePath = await this.downloadAudio(audioUrl, filename);
      
      // Transcrever (agora passando a chave OpenAI)
      const transcription = await this.transcribeAudio(tempFilePath, openaiApiKey);
      
      return {
        success: true,
        transcription: transcription,
        audioUrl: audioUrl,
        messageId: messageId
      };
      
    } catch (error) {
      console.error('[AudioTranscription] Erro no processamento completo:', error);
      return {
        success: false,
        error: error.message,
        audioUrl: audioUrl,
        messageId: messageId
      };
    } finally {
      // Limpar arquivo original
      if (tempFilePath) {
        this.cleanupTempFile(tempFilePath);
      }
      
      // Limpar possíveis arquivos temporários criados durante as tentativas
      if (tempFilePath && tempFilePath.endsWith('.ogg')) {
        const basePath = tempFilePath.replace('.ogg', '');
        this.cleanupTempFile(`${basePath}.webm`);
        this.cleanupTempFile(`${basePath}.wav`);
      }
    }
  }

  /**
   * Formata a transcrição para a IA processar
   */
  static formatTranscriptionForAI(transcription, audioUrl) {
    return `🎵 ÁUDIO TRANSCRITO: "${transcription}"

[Observação: O cliente enviou uma mensagem de áudio que foi transcrita automaticamente. Responda de forma natural baseada no conteúdo transcrito.]`;
  }

  /**
   * Detecta se o áudio está vazio ou muito curto
   */
  static isValidAudioDuration(messageData) {
    try {
      const message = messageData?.message || messageData;
      
      // Verificar duração mínima (em segundos)
      const duration = message?.audioMessage?.seconds || 
                      message?.voiceMessage?.seconds || 
                      message?.pttMessage?.seconds || 0;
      
      // Considerar válido se duração >= 1 segundo
      return duration >= 1;
    } catch (error) {
      console.error('[AudioTranscription] Erro ao verificar duração:', error);
      return true; // Assumir válido se não conseguir verificar
    }
  }

  /**
   * Obtém informações do áudio para logs
   */
  static getAudioInfo(messageData) {
    try {
      const message = messageData?.message || messageData;
      
      const audioMessage = message?.audioMessage || message?.voiceMessage || message?.pttMessage;
      
      return {
        duration: audioMessage?.seconds || 0,
        fileSize: audioMessage?.fileLength || 0,
        mimetype: audioMessage?.mimetype || 'unknown',
        hasUrl: !!(audioMessage?.url || audioMessage?.directPath)
      };
    } catch (error) {
      console.error('[AudioTranscription] Erro ao obter info do áudio:', error);
      return {
        duration: 0,
        fileSize: 0,
        mimetype: 'unknown',
        hasUrl: false
      };
    }
  }
}

export default AudioTranscriptionService; 