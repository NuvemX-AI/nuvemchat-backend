// Import this first from sentry instrument!
import '@utils/instrumentSentry';

// Now import other modules
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { HttpStatus, router } from '@api/routes/index.router';
import { eventManager, waMonitor } from '@api/server.module';
import { Auth, configService, Cors, HttpServer, ProviderSession, Webhook } from '@config/env.config';
import { onUnexpectedError } from '@config/error.config';
import { Logger } from '@config/logger.config';
import { ROOT_DIR } from '@config/path.config';
import * as Sentry from '@sentry/node';
import { ServerUP } from '@utils/server-up';
import axios from 'axios';
import compression from 'compression';
import cors from 'cors';
import express, { json, NextFunction, Request, Response, urlencoded } from 'express';
import { join } from 'path';

// Import the unified Evolution API bootstrap function
import { bootstrapEvolution } from './evolution/main';

function initWA() {
  waMonitor.loadInstance();
}

async function bootstrap() {
  const logger = new Logger('SERVER');
  const app = express();

  // Optionally initialize ProviderFiles
  let providerFiles: ProviderFiles = null;
  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    providerFiles = new ProviderFiles(configService);
    await providerFiles.onModuleInit();
    logger.info('Provider:Files - ON');
  }

  // Initialize Prisma repository
  const prismaRepository = new PrismaRepository(configService);
  await prismaRepository.onModuleInit();

  // Apply middlewares
  app.use(
    cors({
      origin(requestOrigin, callback) {
        const { ORIGIN } = configService.get<Cors>('CORS');
        if (ORIGIN.includes('*')) return callback(null, true);
        if (ORIGIN.indexOf(requestOrigin) !== -1) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
      },
      methods: [...configService.get<Cors>('CORS').METHODS],
      credentials: configService.get<Cors>('CORS').CREDENTIALS,
    }),
    urlencoded({ extended: true, limit: '136mb' }),
    json({ limit: '136mb' }),
    compression(),
  );

  // View engine & static files
  app.set('view engine', 'hbs');
  app.set('views', join(ROOT_DIR, 'views'));
  app.use(express.static(join(ROOT_DIR, 'public')));
  app.use('/store', express.static(join(ROOT_DIR, 'store')));

  // Mount unified Evolution API under /evolution
  await bootstrapEvolution(app);
  logger.info('Evolution API - Mounted at /evolution');

  // Mount existing routes
  app.use('/', router);

  // Error handling middlewares
  app.use(
    (err: Error, req: Request, res: Response, next: NextFunction) => {
      if (err) {
        const webhook = configService.get<Webhook>('WEBHOOK');
        if (webhook.EVENTS.ERRORS_WEBHOOK && webhook.EVENTS.ERRORS) {
          const tzoffset = new Date().getTimezoneOffset() * 60000;
          const localISOTime = new Date(Date.now() - tzoffset).toISOString();
          const errorData = {
            event: 'error',
            data: {
              error: err['error'] || 'Internal Server Error',
              message: err['message'] || 'Internal Server Error',
              status: err['status'] || 500,
              response: { message: err['message'] || 'Internal Server Error' },
            },
            date_time: localISOTime,
            api_key: configService.get<Auth>('AUTHENTICATION').API_KEY.KEY,
            server_url: configService.get<HttpServer>('SERVER').URL,
          };
          logger.error(errorData);
          axios.post(webhook.EVENTS.ERRORS_WEBHOOK, errorData);
        }
        return res.status(err['status'] || 500).json({
          status: err['status'] || 500,
          error: err['error'] || 'Internal Server Error',
          response: { message: err['message'] || 'Internal Server Error' },
        });
      }
      next();
    },
    (req: Request, res: Response) => {
      res.status(HttpStatus.NOT_FOUND).json({
        status: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        response: { message: [`Cannot ${req.method} ${req.url}`] },
      });
    },
  );

  // Initialize server
  const httpServer = configService.get<HttpServer>('SERVER');
  ServerUP.app = app;
  const server = ServerUP[httpServer.TYPE];

  // Setup Sentry error handler
  if (process.env.SENTRY_DSN) {
    logger.info('Sentry - ON');
    Sentry.setupExpressErrorHandler(app);
  }

  server.listen(httpServer.PORT, () =>
    logger.log(`${httpServer.TYPE.toUpperCase()} - ON: ${httpServer.PORT}`),
  );

  initWA();
  onUnexpectedError();
}

bootstrap();
