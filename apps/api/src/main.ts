import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { runInWorkspaceContext } from '@core/infra';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // Fail-closed en producción: sin un JWT_SECRET propio (o con el default de dev), CUALQUIERA podría
  // forjar tokens de sesión. Preferimos no arrancar a operar con un secreto público conocido.
  if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-only-change-me')) {
    throw new Error('JWT_SECRET debe fijarse a un valor propio en producción (no el default de desarrollo).');
  }

  // `rawBody: true` expone `req.rawBody` (Buffer) para verificar la firma HMAC de los webhooks
  // sobre los BYTES exactos recibidos (M7), sin depender de la re-serialización del JSON parseado.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors();

  // 2ª barrera RLS (M10, opt-in): abre un contexto de tenant por petición que envuelve TODO el
  // pipeline (guard→servicio→adaptador Prisma). El guard JWT escribe el workspace tras validar el
  // token; la extensión RLS de Prisma lo lee para el SET LOCAL. Middleware raíz para cubrir la
  // cadena async completa. Sin RLS_ENABLED no se monta (comportamiento previo intacto).
  if (process.env.RLS_ENABLED === '1' || process.env.RLS_ENABLED === 'true') {
    app.use((_req: unknown, _res: unknown, next: () => void) => runInWorkspaceContext({}, next));
  }
  // Railway (y otros PaaS) inyectan PORT; en local usamos API_PORT. Escucha en 0.0.0.0 para el contenedor.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  console.log(`AgentFlow API escuchando en el puerto ${port}`);
}

void bootstrap();
