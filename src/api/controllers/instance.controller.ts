// src/api/controllers/instance.controller.ts

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

  public async createInstance(instanceData: InstanceDto) {
    try {
      const instance = channelController.init(instanceData, {
        configService: this.configService,
        eventEmitter: this.eventEmitter,
        prismaRepository: this.prismaRepository,
        cache: this.cache,
        chatwootCache: this.chatwootCache,
        baileysCache: this.baileysCache,
        providerFiles: this.providerFiles,
      });
      if (!instance) throw new BadRequestException('Invalid integration');

      const instanceId = v4();
      instanceData.instanceId = instanceId;
      const hash = instanceData.token ?? v4().toUpperCase();

      await this.waMonitor.saveInstance({
        instanceId,
        integration: instanceData.integration,
        instanceName: instanceData.instanceName,
        ownerJid: instanceData.ownerJid,
        profileName: instanceData.profileName,
        profilePicUrl: instanceData.profilePicUrl,
        hash,
        number: instanceData.number,
        businessId: instanceData.businessId,
        status: instanceData.status,
      });

      instance.setInstance({
        instanceName: instanceData.instanceName,
        instanceId,
        integration: instanceData.integration,
        token: hash,
        number: instanceData.number,
        businessId: instanceData.businessId,
      });
      this.waMonitor.waInstances[instance.instanceName] = instance;
      this.waMonitor.delInstanceTime(instance.instanceName);

      await eventManager.setInstance(instance.instanceName, instanceData);
      instance.sendDataWebhook(Events.INSTANCE_CREATE, { instanceName: instanceData.instanceName, instanceId });

      // Proxy config
      if (instanceData.proxyHost && instanceData.proxyPort && instanceData.proxyProtocol) {
        const testProxy = await this.proxyService.testProxy({
          host: instanceData.proxyHost,
          port: instanceData.proxyPort,
          protocol: instanceData.proxyProtocol,
          username: instanceData.proxyUsername,
          password: instanceData.proxyPassword,
        });
        if (!testProxy) throw new BadRequestException('Invalid proxy');

        await this.proxyService.createProxy(instance, {
          enabled: true,
          host: instanceData.proxyHost,
          port: instanceData.proxyPort,
          protocol: instanceData.proxyProtocol,
          username: instanceData.proxyUsername,
          password: instanceData.proxyPassword,
        });
      }

      // Settings
      const settings: wa.LocalSettings = {
        rejectCall: Boolean(instanceData.rejectCall),
        msgCall: instanceData.msgCall || '',
        groupsIgnore: Boolean(instanceData.groupsIgnore),
        alwaysOnline: Boolean(instanceData.alwaysOnline),
        readMessages: Boolean(instanceData.readMessages),
        readStatus: Boolean(instanceData.readStatus),
        syncFullHistory: Boolean(instanceData.syncFullHistory),
        wavoipToken: instanceData.wavoipToken || '',
      };
      await this.settingsService.create(instance, settings);

      // WhatsApp Business webhook
      let webhookWaBusiness: string | null = null;
      let accessTokenWaBusiness = '';
      if (instanceData.integration === Integration.WHATSAPP_BUSINESS) {
        if (!instanceData.number) throw new BadRequestException('number is required');
        const urlServer = this.configService.get<HttpServer>('SERVER').URL;
        webhookWaBusiness = `${urlServer}/webhook/meta`;
        accessTokenWaBusiness = this.configService.get<WaBusiness>('WA_BUSINESS').TOKEN_WEBHOOK;
      }

      // QR code flow (Baileys)
      if (!instanceData.chatwootAccountId || !instanceData.chatwootToken || !instanceData.chatwootUrl) {
        let getQrcode: wa.QrCode;
        if (instanceData.qrcode && instanceData.integration === Integration.WHATSAPP_BAILEYS) {
          await instance.connectToWhatsapp(instanceData.number);
          await delay(5000);
          getQrcode = instance.qrCode;
        }
        return {
          instance: {
            instanceName: instance.instanceName,
            instanceId,
            integration: instanceData.integration,
            webhookWaBusiness,
            accessTokenWaBusiness,
            status: instance.connectionStatus.state,
          },
          hash,
          webhook: {
            webhookUrl: instanceData.webhook?.url,
            webhookHeaders: instanceData.webhook?.headers,
            webhookByEvents: instanceData.webhook?.byEvents,
            webhookBase64: instanceData.webhook?.base64,
          },
          websocket: { enabled: instanceData.websocket?.enabled },
          rabbitmq: { enabled: instanceData.rabbitmq?.enabled },
          sqs: { enabled: instanceData.sqs?.enabled },
          settings,
          qrcode: getQrcode,
        };
      }

      // Chatwoot integration
      if (!this.configService.get<Chatwoot>('CHATWOOT').ENABLED) throw new BadRequestException('Chatwoot is not enabled');
      if (!instanceData.chatwootAccountId) throw new BadRequestException('accountId is required');
      if (!instanceData.chatwootToken) throw new BadRequestException('token is required');
      if (!instanceData.chatwootUrl) throw new BadRequestException('url is required');
      if (!isURL(instanceData.chatwootUrl, { require_tld: false })) throw new BadRequestException('Invalid "url" property in chatwoot');
      if (![true, false].includes(instanceData.chatwootSignMsg as boolean)) throw new BadRequestException('signMsg is required');
      if (![true, false].includes(instanceData.chatwootReopenConversation as boolean)) throw new BadRequestException('reopenConversation is required');
      if (![true, false].includes(instanceData.chatwootConversationPending as boolean)) throw new BadRequestException('conversationPending is required');

      const urlServer = this.configService.get<HttpServer>('SERVER').URL;
      try {
        this.chatwootService.create(instance, {
          enabled: true,
          accountId: instanceData.chatwootAccountId,
          token: instanceData.chatwootToken,
          url: instanceData.chatwootUrl,
          signMsg: instanceData.chatwootSignMsg || false,
          nameInbox: instanceData.chatwootNameInbox ?? instance.instanceName.split('-cwId-')[0],
          number: instanceData.number,
          reopenConversation: instanceData.chatwootReopenConversation || false,
          conversationPending: instanceData.chatwootConversationPending || false,
          importContacts: instanceData.chatwootImportContacts ?? true,
          mergeBrazilContacts: instanceData.chatwootMergeBrazilContacts ?? false,
          importMessages: instanceData.chatwootImportMessages ?? true,
          daysLimitImportMessages: instanceData.chatwootDaysLimitImportMessages ?? 60,
          organization: instanceData.chatwootOrganization,
          logo: instanceData.chatwootLogo,
          autoCreate: instanceData.chatwootAutoCreate !== false,
        });
      } catch (error) {
        this.logger.log(error);
      }

      // Final return
      return {
        instance: {
          instanceName: instance.instanceName,
          instanceId,
          integration: instanceData.integration,
          webhookWaBusiness,
          accessTokenWaBusiness,
          status: instance.connectionStatus.state,
        },
        hash,
        webhook: {
          webhookUrl: instanceData.webhook?.url,
          webhookHeaders: instanceData.webhook?.headers,
          webhookByEvents: instanceData.webhook?.byEvents,
          webhookBase64: instanceData.webhook?.base64,
        },
        websocket: { enabled: instanceData.websocket?.enabled },
        rabbitmq: { enabled: instanceData.rabbitmq?.enabled },
        sqs: { enabled: instanceData.sqs?.enabled },
        settings,
        chatwoot: {
          enabled: true,
          accountId: instanceData.chatwootAccountId,
          token: instanceData.chatwootToken,
          url: instanceData.chatwootUrl,
          signMsg: instanceData.chatwootSignMsg || false,
          reopenConversation: instanceData.chatwootReopenConversation || false,
          conversationPending: instanceData.chatwootConversationPending || false,
          mergeBrazilContacts: instanceData.chatwootMergeBrazilContacts ?? false,
          importContacts: instanceData.chatwootImportContacts ?? true,
          importMessages: instanceData.chatwootImportMessages ?? true,
          daysLimitImportMessages: instanceData.chatwootDaysLimitImportMessages || 60,
          number: instanceData.number,
          nameInbox: instanceData.chatwootNameInbox ?? instance.instanceName,
          webhookUrl: `${urlServer}/chatwoot/webhook/${encodeURIComponent(instance.instanceName)}`,
        },
      };
    } catch (error) {
      this.waMonitor.deleteInstance(instanceData.instanceName);
      this.logger.error(isArray(error.message) ? error.message[0] : error.message);
      throw new BadRequestException(isArray(error.message) ? error.message[0] : error.message);
    }
  }

  public async connectToWhatsapp({ instanceName, number = null }: InstanceDto) {
    try {
      const instance = this.waMonitor.waInstances[instanceName];
      const state = instance?.connectionStatus?.state;
      if (!state) throw new BadRequestException(`The "${instanceName}" instance does not exist`);
      if (state === 'open') return await this.connectionState({ instanceName });
      if (state === 'connecting') return instance.qrCode;
      if (state === 'close') {
        await instance.connectToWhatsapp(number);
        await delay(2000);
        return instance.qrCode;
      }
      return { instance: { instanceName, status: state }, qrcode: instance?.qrCode };
    } catch (error) {
      this.logger.error(error);
      return { error: true, message: error.toString() };
    }
  }

  public async restartInstance({ instanceName }: InstanceDto) {
    try {
      const inst = this.waMonitor.waInstances[instanceName];
      const state = inst?.connectionStatus?.state;
      if (!state) throw new BadRequestException(`The "${instanceName}" instance does not exist`);
      if (state === 'close') throw new BadRequestException(`The "${instanceName}" instance is not connected`);
      if (state === 'open' || state === 'connecting') {
        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) inst.clearCacheChatwoot();
        inst.client?.ws?.close();
        inst.client?.end(new Error('restart'));
        return await this.connectToWhatsapp({ instanceName });
      }
    } catch (error) {
      this.logger.error(error);
      return { error: true, message: error.toString() };
    }
  }

  public async connectionState({ instanceName }: InstanceDto) {
    return { instance: { instanceName, state: this.waMonitor.waInstances[instanceName]?.connectionStatus?.state } };
  }

  public async fetchInstances({ instanceName, instanceId, number }: InstanceDto, key: string) {
    const env = this.configService.get<Auth>('AUTHENTICATION').API_KEY;
    if (env.KEY !== key) {
      const instancesByKey = await this.prismaRepository.whatsappIntegration.findMany({
        where: {
          sessionData: { path: ['token'], equals: key },
          instanceName: instanceName || undefined,
          id: instanceId || undefined,
        },
      });
      if (instancesByKey.length) {
        const names = instancesByKey.map((i) => i.instanceName);
        return this.waMonitor.instanceInfo(names);
      }
      throw new UnauthorizedException();
    }
    if (instanceId || number) return this.waMonitor.instanceInfoById(instanceId, number);
    const instanceNames = instanceName ? [instanceName] : null;
    return this.waMonitor.instanceInfo(instanceNames);
  }

  public async setPresence({ instanceName }: InstanceDto, data: SetPresenceDto) {
    return await this.waMonitor.waInstances[instanceName].setPresence(data);
  }

  public async logout({ instanceName }: InstanceDto) {
    const { instance } = await this.connectionState({ instanceName });
    if (instance.state === 'close') throw new BadRequestException(`The "${instanceName}" instance is not connected`);
    try {
      this.waMonitor.waInstances[instanceName]?.logoutInstance();
      return { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } };
    } catch (error) {
      throw new InternalServerErrorException(error.toString());
    }
  }

  public async deleteInstance({ instanceName }: InstanceDto) {
    const { instance } = await this.connectionState({ instanceName });
    try {
      const inst = this.waMonitor.waInstances[instanceName];
      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) inst.clearCacheChatwoot();
      if (instance.state === 'connecting' || instance.state === 'open') await this.logout({ instanceName });
      try {
        inst.sendDataWebhook(Events.INSTANCE_DELETE, { instanceName, instanceId: inst.instanceId });
      } catch (err) {
        this.logger.error(err);
      }
      this.eventEmitter.emit('remove.instance', instanceName, 'inner');
      return { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } };
    } catch (error) {
      throw new BadRequestException(error.toString());
    }
  }
}
