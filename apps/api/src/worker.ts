import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { runInWorkspaceContext } from '@core/infra/postgres';
import { executionRoomName } from '@core/infra/cloudflare';
import { toErrorResponse } from './http/common';
import { authMiddleware, type AuthVariables } from './http/auth.middleware';
import { buildCloudflarePersistence, closeBundle } from './http/composition';
import { buildServices, type Services } from './http/services';
import { WorkflowsDispatcher } from './execution/dispatcher';
import { agentsRouter } from './http/routers/agents';
import { workflowsRouter } from './http/routers/workflows';
import { executionsRouter } from './http/routers/executions';
import { llmKeysRouter } from './http/routers/llm-keys';
import { authRouter } from './http/routers/auth';
import { teamRouter } from './http/routers/team';
import { connectorsRouter, devOAuthRouter } from './http/routers/connectors';
import {
  apiKeysRouter,
  workflowSchedulesRouter,
  schedulesAdminRouter,
  workflowWebhooksRouter,
  webhooksAdminRouter,
  hooksRouter,
  workflowTriggersRouter,
  triggersAdminRouter,
  providerHooksRouter,
  jiraProjectsRouter,
  sharesRouter,
} from './http/routers/misc';
import type { Env } from './http/env';

export { ExecutionRoom } from './durable/execution-room';
export { WorkspaceUsage } from './durable/workspace-usage';
export { ExecutionWorkflow } from './workflows/execution.workflow';

/**
 * ¿Le toca disparar a este schedule en el minuto actual?
 *
 * El Cron Trigger corre CADA MINUTO y aquí se decide quién dispara, porque los patrones cron son por
 * schedule y viven en la base de datos — Cloudflare solo admite crons fijos en la configuración del
 * Worker, no uno por fila.
 */
function dueNow(s: { cron: string | null; everyMs: number | null; createdAt: string }, now = new Date()): boolean {
  if (s.cron) return cronMatches(s.cron, now);
  if (s.everyMs && s.everyMs > 0) {
    // Intervalo anclado a la creación, redondeado al minuto: el tick es minutal, así que un `everyMs`
    // por debajo de 60_000 dispara como mucho una vez por minuto.
    const elapsed = now.getTime() - new Date(s.createdAt).getTime();
    return elapsed >= 0 && Math.floor(elapsed / s.everyMs) !== Math.floor((elapsed - 60_000) / s.everyMs);
  }
  return false;
}

/** Evalúa un cron de 5 campos (min hora díames mes díasemana) contra una fecha, en UTC. */
function cronMatches(pattern: string, now: Date): boolean {
  const fields = pattern.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [now.getUTCMinutes(), now.getUTCHours(), now.getUTCDate(), now.getUTCMonth() + 1, now.getUTCDay()];
  return fields.every((field, i) => matchField(field, values[i]));
}

function matchField(field: string, value: number): boolean {
  return field.split(',').some((part) => {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step <= 0) return false;
    if (range === '*') return value % step === 0;
    const [fromRaw, toRaw] = range.split('-');
    const from = Number(fromRaw);
    const to = toRaw != null ? Number(toRaw) : from;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    // El domingo se acepta como 0 y como 7, igual que en cron de toda la vida.
    const hit = (value >= from && value <= to) || (value === 0 && from <= 7 && to >= 7);
    return hit && (value - from) % step === 0;
  });
}

/**
 * Entry del API en Cloudflare Workers. Sustituye a `main.ts` (NestFactory + Express).
 *
 * ⚠️ PORT INCOMPLETO. Faltan los routers de `PENDIENTES`, que responden 501
 * con la lista de lo que falta (ver `PENDIENTES`), en vez de 404: un 404 se confundiría con una ruta que
 * no existe y haría pensar que el port está terminado. NO desplegar esto como el API de producción
 * todavía — por eso tampoco hay workflow de deploy.
 */

// `mcp` usa el transporte Streamable HTTP del SDK, que exige los objetos IncomingMessage/ServerResponse
// de Node; portarlo pide un transporte nuevo sobre Request/Response. `analytics` simplemente falta.
const PENDIENTES = ['mcp', 'analytics'];

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
    c.set('services', buildServices(bundle, jwtSecret, new WorkflowsDispatcher(c.env.EXECUTION)));
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
    const upgraded = (await stub.fetch('https://do.invalid/ws', {
      headers: { Upgrade: 'websocket' },
    })) as unknown as Response;

    // Hay que DEVOLVER el subprotocolo aceptado o el navegador cierra la conexión nada más abrirla.
    if (upgraded.status === 101 && c.req.header('sec-websocket-protocol')) {
      const headers = new Headers(upgraded.headers);
      headers.set('Sec-WebSocket-Protocol', 'bearer');
      return new Response(upgraded.body, { status: 101, headers, webSocket: (upgraded as { webSocket?: unknown }).webSocket } as ResponseInit);
    }
    return upgraded;
  });

  app.route('/auth', authRouter());
  app.route('/team', teamRouter());
  app.route('/agents', agentsRouter());
  app.route('/executions', executionsRouter());
  app.route('/llm-keys', llmKeysRouter());
  app.route('/api-keys', apiKeysRouter());
  app.route('/connectors', connectorsRouter());
  app.route('/connectors/:connectorId/jira-projects', jiraProjectsRouter());

  // Sub-recursos de un workflow ANTES que el router de `/workflows`: Hono casa por orden, y `/:id`
  // del router de workflows se tragaría `/workflows/x/schedules` si fuese primero.
  app.route('/workflows/:workflowId/schedules', workflowSchedulesRouter());
  app.route('/workflows/:workflowId/webhooks', workflowWebhooksRouter());
  app.route('/workflows/:workflowId/triggers', workflowTriggersRouter());
  app.route('/workflows', workflowsRouter());

  app.route('/schedules', schedulesAdminRouter());
  app.route('/webhooks', webhooksAdminRouter());
  app.route('/triggers', triggersAdminRouter());

  // Ingreso público de terceros. `/hooks/jira` y `/hooks/sentry` van antes que `/hooks/:token`.
  app.route('/hooks', providerHooksRouter());
  app.route('/hooks', hooksRouter());

  // Shares se monta en la raíz: sus rutas viven en dos árboles (`/workflows/:id/share` y `/shares/...`).
  app.route('/', sharesRouter());

  // Proveedor OAuth de juguete: auto-aprueba y emite tokens sin verificar identidad. Nunca en producción.
  if (process.env.NODE_ENV !== 'production') app.route('/oauth/dev', devOAuthRouter());

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
  /**
   * Cron Trigger (cada minuto): dispara los triggers programados. Sustituye a los repeatable jobs de
   * BullMQ y al bucle del `apps/worker`, que ya no existen.
   *
   * La fila del schedule es la ÚNICA fuente de verdad: se leen los activos y se ejecuta el que toca.
   * Con BullMQ había dos —la fila y el job scheduler en Redis— y mantenerlas sincronizadas era la
   * mayor parte de la complejidad de `SchedulesService`.
   */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const { bundle, pool } = buildCloudflarePersistence(env);
    try {
      const services = buildServices(bundle, env.JWT_SECRET ?? '', new WorkflowsDispatcher(env.EXECUTION));
      const active = await bundle.schedules.listActive();
      for (const s of active) {
        if (!dueNow(s)) continue;
        try {
          await services.executions.start(s.workflowId, s.workspaceId, {}, 'cron');
        } catch (e) {
          // Un schedule que falla no debe impedir que disparen los demás en este tick.
          console.error(`[schedule] ${s.id} falló:`, e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      ctx.waitUntil(closeBundle(pool));
    }
  },

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
