import { InstanceDto, SetPresenceDto } from '@api/dto/instance.dto';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { channelController, eventManager } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { SettingsService } from '@api/services/settings.service';
import { Events, Integration, wa } from '@api/types/wa.types';
import { Auth, Chatwoot, ConfigService, HttpServer, WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException, InternalServerErrorException, UnauthorizedException } from '@exceptions';
import { delay } from 'baileys';
import { isArray, isURL } from 'class-validator';
import EventEmitter2 from 'eventemitter2';
import { v4 } from 'uuid';
import { ProxyController } from './proxy.controller';

export class InstanceController {
  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly chatwootService: ChatwootService,
    private readonly settingsService: SettingsService,
    private readonly proxyService: ProxyController,
    private readonly cache: CacheService,
    private readonly chatwootCache: CacheService,
    private readonly baileysCache: CacheService,
    private readonly providerFiles: ProviderFiles,
  ) {}

  private readonly logger = new Logger('InstanceController');

  // ... (mantém todos os outros métodos idênticos)

  public async fetchInstances({ instanceName, instanceId, number }: InstanceDto, key: string) {
    const env = this.configService.get<Auth>('AUTHENTICATION').API_KEY;
    if (env.KEY !== key) {
      // PATCH: agora usa acesso direto porque PrismaRepository herda PrismaClient!
      const instancesByKey = await this.prismaRepository.instance.findMany({
        where: {
          token: key,
          name: instanceName || undefined,
          id: instanceId || undefined,
        },
      });
      if (instancesByKey.length > 0) {
        const names = instancesByKey.map((instance) => instance.name);
        return this.waMonitor.instanceInfo(names);
      } else {
        throw new UnauthorizedException();
      }
    }
    if (instanceId || number) {
      return this.waMonitor.instanceInfoById(instanceId, number);
    }
    const instanceNames = instanceName ? [instanceName] : null;
    return this.waMonitor.instanceInfo(instanceNames);
  }

  // ... (mantém todos os outros métodos idênticos)
}
