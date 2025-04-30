// evolution-api/src/main.ts
import express, { Application, Router } from 'express';
import { createEvolutionRouter } from './evolution.router'; 
// ⚠️ Se o seu router estiver em outro caminho, ajuste para:
// import { createEvolutionRouter } from './api/integrations/channel/evolution/evolution.router';

/**
 * Cria e configura o sub-app da Evolution API
 * @returns um express.Application com todas as rotas da Evolution
 */
export function createEvolutionApp(): Application {
  const app = express();

  // Middlewares comuns (ajuste conforme suas necessidades)
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Aqui montamos as rotas originais da Evolution
  const evoRouter = Router();
  createEvolutionRouter(evoRouter);
  app.use('/evolution', evoRouter);

  // Se houver tratamento de erros específico, registre aqui, por exemplo:
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Evolution API Error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
  });

  return app;
}

// Se for executado diretamente (node src/main.ts), mantém a porta 8081:
if (require.main === module) {
  const standaloneApp = createEvolutionApp();
  const port = process.env.PORT_EV || 8081;
  standaloneApp.listen(port, () =>
    console.log(`Evolution API standalone - ON: ${port}`)
  );
}
