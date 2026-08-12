import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { runInWorkspaceContext } from '@core/infra/postgres';
import { executionRoomName } from '@core/infra/cloudflare';
import { toErrorResponse } from './http/common';
import { authMiddleware, type AuthVariables } from './http/auth.middleware';
import { buildCloudflarePersistence, closeBundle } from './http/composition';
import { buildServices, type Services } from './http/services';
import { agentsRouter } from './http/routers/agents';
import { workflowsRouter } from './http/routers/workflows';
import { executionsRouter } from './http/routers/executions';
import { llmKeysRouter } from './http/routers/llm-keys';
import type { Env } from './http/env';

export { ExecutionRoom } from './durable/execution-room';
export { WorkspaceUsage } from './durable/workspace-usage';

/**
 * Entry del API en Cloudflare Workers. Sustituye a `main.ts` (NestFactory + Express).
 *
 * ⚠️ PORT INCOMPLETO. Faltan los routers de `PENDIENTES`, que responden 501
 * con la lista de lo que falta (ver `PENDIENTES`), en vez de 404: un 404 se confundiría con una ruta que
 * no existe y haría pensar que el port está terminado. NO desplegar esto como el API de producción
 * todavía — por eso tampoco hay workflow de deploy.
 */

const PENDIENTES = [
  'auth', 'webhooks', 'schedules', 'connectors', 'triggers',
  'api-keys', 'mcp', 'team', 'analytics', 'shares',
];

type AppEnv = { Bindings: Env; Variables: AuthVariables & { services: Services } };

function createApp(jwtSecret: string) {
  const app = new Hono<AppEnv>();

  // Traduce HttpError a respuesta. Equivalente del filtro de excepciones de Nest; un error que no sea
  // HttpError sale como 500 genérico sin filtrar internals.
  app.onError((err) => {
    const { status, body } = toErrorResponse(err);
    return Response.json(body, { status });
  });

  app.use('*', cors());

  /**
   * Construye el bundle de la petición y abre el contexto de tenant que envuelve TODO lo demás
   * (middleware de auth → handler → adaptador Prisma). El middleware de auth escribe el workspace en él
   * tras validar el token, y la extensión RLS de Prisma lo lee para el SET LOCAL. Igual que el
   * middleware raíz de `main.ts`, y por la misma razón: tiene que cubrir la cadena async completa.
   */
  app.use('*', async (c, next) => {
    const { bundle, pool } = buildCloudflarePersistence(c.env);
    c.set('persistence', bundle);
    c.set('services', buildServices(bundle));
    try {
      await runInWorkspaceContext({}, () => next());
    } finally {
      // Fuera de la respuesta para no retrasarla, pero SIEMPRE: un pool sin cerrar deja una conexión
      // abierta de un isolate que ya no existe.
      c.executionCtx.waitUntil(closeBundle(pool));
    }
  });

  app.use('*', authMiddleware(jwtSecret));

  app.get('/', (c) => c.json({ ok: true }));
  app.get('/health', (c) => c.json({ ok: true }));

  /**
   * Suscripción al stream de una ejecución. Reemplaza al handshake de socket.io del `TelemetryGateway`.
   *
   * La AUTORIZACIÓN se hace AQUÍ, antes de pasar el socket al Durable Object: el middleware ya validó el
   * JWT, y esto comprueba además que la ejecución pertenece al workspace del token. El DO no autentica
   * —solo es alcanzable por binding— igual que el gateway autorizaba explícitamente porque el guard HTTP
   * global no cubría los WebSockets.
   */
  app.get('/executions/:id/stream', async (c) => {
    const id = c.req.param('id');
    const execution = await c.get('persistence').executions.get(id);
    if (!execution || execution.workspaceId !== c.get('user').workspaceId) {
      return c.json({ statusCode: 404, message: 'Ejecución no encontrada.' }, 404);
    }
    const ns = c.env.EXECUTION_ROOM;
    const stub = ns.get(ns.idFromName(executionRoomName(id)));
    return stub.fetch('https://do.invalid/ws', {
      headers: { Upgrade: 'websocket' },
    }) as unknown as Response;
  });

  app.route('/agents', agentsRouter());
  app.route('/workflows', workflowsRouter());
  app.route('/executions', executionsRouter());
  app.route('/llm-keys', llmKeysRouter());

  app.all('*', (c) =>
    c.json(
      {
        statusCode: 501,
        message: 'Ruta no portada todavía al Worker. Ver docs/CLOUDFLARE.md.',
        pendientes: PENDIENTES,
      },
      501,
    ),
  );

  return app;
}

export default {
  fetch(request: Request, env: Env, ctx: unknown): Response | Promise<Response> {
    // Fail-closed, igual que `main.ts`: sin un JWT_SECRET propio cualquiera podría forjar sesiones.
    // Aquí no hay arranque en el que fallar, así que se comprueba en la primera petición.
    const secret = env.JWT_SECRET;
    if (!secret || secret === 'dev-only-change-me') {
      console.error('[api] JWT_SECRET debe fijarse a un valor propio (no el default de desarrollo).');
      return Response.json({ statusCode: 500, message: 'Configuración incompleta.' }, { status: 500 });
    }
    return createApp(secret).fetch(request, env, ctx as never);
  },
};
