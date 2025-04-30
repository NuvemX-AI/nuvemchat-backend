// src/evolution/main.ts
// Entrypoint for mounting the Evolution API into the main Express app
import express, { Application, Router } from 'express';
import { createEvolutionRouter } from './evolution.router'; // ajuste este import conforme sua estrutura

/**
 * Mounts all Evolution API routes under /evolution
 */
export function bootstrapEvolution(app: Application) {
  const evoRouter = Router();
  // Registre aqui todas as rotas da Evolution API
  createEvolutionRouter(evoRouter);

  // Monta o router no endpoint /evolution
  app.use('/evolution', evoRouter);
}

// Se desejar rodar a Evolution API separadamente (opcional)
if (require.main === module) {
  (async () => {
    const app = express();
    bootstrapEvolution(app);
    const port = process.env.PORT_EV || 8081;
    app.listen(port, () => console.log(`Evolution API standalone - ON: ${port}`));
  })();
}
