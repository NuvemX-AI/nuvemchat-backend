import { InstanceDto } from '@api/dto/instance.dto';
import { prismaRepository } from '@api/server.module';
import { Auth, configService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { ForbiddenException, UnauthorizedException } from '@exceptions';
import { NextFunction, Request, Response } from 'express';

const logger = new Logger('GUARD');

/**
 * Verifica a chave de API global ou por integração de WhatsApp.
 */
async function apikey(req: Request, _: Response, next: NextFunction) {
  const env = configService.get<Auth>('AUTHENTICATION').API_KEY;
  const key = req.get('apikey');
  const db = configService.get<Database>('DATABASE');

  if (!key) {
    throw new UnauthorizedException();
  }

  // Se a chave for a chave global, permite acesso
  if (env.KEY === key) {
    return next();
  }

  const param = req.params as unknown as InstanceDto;

  try {
    // Autenticação por integração específica
    if (param?.instanceName) {
      // Busca pelo instanceId na tabela WhatsappIntegration
      const integration = await prismaRepository.whatsappIntegration.findUnique({
        where: { instanceId: param.instanceName },
      });
      if (integration && typeof integration.sessionData === 'object' && 'token' in integration.sessionData && (integration.sessionData as any).token === key) {
        return next();
      }
    } else {
      // Para rota fetchInstances quando SAVE_DATA.INSTANCE habilitado
      if (req.originalUrl.includes('/instance/fetchInstances') && db.SAVE_DATA.INSTANCE) {
        const integrationByKey = await prismaRepository.whatsappIntegration.findFirst({
          where: { sessionData: { path: ['token'], equals: key } },
        });
        if (integrationByKey) {
          return next();
        }
      }
    }
  } catch (error) {
    logger.error(error);
  }

  throw new UnauthorizedException();
}

export const authGuard = { apikey };
