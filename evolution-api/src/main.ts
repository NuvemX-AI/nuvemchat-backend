// evolution-api/src/main.ts
import express, { Application, Router } from 'express';
import { createEvolutionRouter } from './evolution.router'; 
// ⚠️ Verifique este caminho: deve apontar para onde você registra suas rotas (controllers, services, etc.)

/**
 * Monta todas as rotas da Evolution API sob /evolution
 */
export function bootstrapEvolution(app: Application) {
  const evoRouter = Router();

  // Aqui você registra suas rotas antigas:
  // ex.: evoRouter.post('/instance', instanceController.create);
  createEvolutionRouter(evoRouter);

  // Monta em /evolution
  app.use('/evolution', evoRouter);
}

// Se for executado diretamente (standalone), mantemos a porta 8081:
if (require.main === module) {
  (async () => {
    const standalone = express();
    bootstrapEvolution(standalone);
    const port = process.env.PORT_EV || 8081;
    standalone.listen(port, () => 
      console.log(`Evolution API standalone - ON: ${port}`)
    );
  })();
}
