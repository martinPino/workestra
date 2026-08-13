import { Hono } from 'hono';
import { CreateShareRequestSchema } from '@core/contracts';
import type { SchedulePoll } from '@core/engine';
import { BadRequestException, UnauthorizedException } from '../common';
import { requireScopes } from '../scopes.middleware';
import { rateLimit } from '../rate-limit.middleware';
import { UnauthorizedSignature } from '../../webhooks/webhooks.service';
import { param, ws, type RouterEnv } from './types';

/**
 * Routers de superficie pequeña, agrupados porque cuelgan de prefijos distintos y cada uno tiene dos o
 * tres rutas: claves de API, schedules, webhooks, triggers y shares.
 *
 * En Nest esto eran nueve `@Controller` repartidos en cinco ficheros, casi todos de una ruta. Aquí la
 * unidad es el PREFIJO de montaje, no el recurso, así que agruparlos evita nueve ficheros de diez líneas
 * sin perder de vista qué scope lleva cada ruta.
 */

/** Lee el cuerpo CRUDO. Es imprescindible para verificar una firma HMAC: hay que hashear los bytes */
/* exactos recibidos, no el JSON re-serializado, que puede diferir en orden de claves o espaciado. */
async function rawBody(c: { req: { arrayBuffer(): Promise<ArrayBuffer> } }): Promise<Buffer> {
  return Buffer.from(await c.req.arrayBuffer());
}

function parseJson(raw: Buffer): unknown {
  try {
    return raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    return {};
  }
}

/** Claves de API por workspace (M32). Mintear una concede acceso → todo el router es `apikey:manage`. */
export function apiKeysRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();
  r.use('*', requireScopes('apikey:manage'));

  r.post('/', async (c) => {
    const b = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });
    return c.json(await c.get('services').apiKeys.create(c.get('user'), b?.label ?? 'MCP'));
  });
  r.get('/', async (c) => c.json(await c.get('services').apiKeys.list(ws(c))));
  r.delete('/:id', async (c) => c.json(await c.get('services').apiKeys.revoke(c.req.param('id'), ws(c))));

  return r;
}

/** Triggers programados de un workflow. Se monta bajo `/workflows/:workflowId/schedules`. */
export function workflowSchedulesRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.post('/', requireScopes('workflow:write'), async (c) => {
    const b = await c.req.json<{ cron?: string; everyMs?: number; poll?: SchedulePoll }>().catch(() => ({}));
    return c.json(await c.get('services').schedules.create(param(c, 'workflowId'), ws(c), b));
  });
  r.get('/', requireScopes('workflow:read'), async (c) =>
    c.json(await c.get('services').schedules.listByWorkflow(param(c, 'workflowId'), ws(c))),
  );

  return r;
}

/** Borrado de un schedule por id. */
export function schedulesAdminRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();
  r.delete('/:id', requireScopes('workflow:write'), async (c) =>
    c.json(await c.get('services').schedules.delete(c.req.param('id'), ws(c))),
  );
  return r;
}

/** Webhooks de un workflow. Se monta bajo `/workflows/:workflowId/webhooks`. */
export function workflowWebhooksRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.post('/', requireScopes('workflow:write'), async (c) => {
    const b = await c.req.json<{ event?: string }>().catch(() => ({}) as { event?: string });
    return c.json(await c.get('services').webhooks.create(param(c, 'workflowId'), ws(c), b?.event));
  });
  r.get('/', requireScopes('workflow:read'), async (c) =>
    c.json(await c.get('services').webhooks.listByWorkflow(param(c, 'workflowId'), ws(c))),
  );

  return r;
}

/** Borrado de un webhook por id. */
export function webhooksAdminRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();
  r.delete('/:id', requireScopes('workflow:write'), async (c) =>
    c.json(await c.get('services').webhooks.delete(c.req.param('id'), ws(c))),
  );
  return r;
}

/**
 * Ingreso PÚBLICO de webhooks: `POST /hooks/:token`. Sin JWT. La credencial es CUALQUIERA de: la firma
 * HMAC del cuerpo (`x-agentflow-signature`), el secreto como cabecera (`x-agentflow-token`, para
 * clientes que no pueden firmar) o el secreto en el query (para los que no pueden fijar cabeceras).
 * 202 con el executionId; credencial inválida ⇒ 401.
 */
export function hooksRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.post('/:token', async (c) => {
    const raw = await rawBody(c);
    try {
      const out = await c
        .get('services')
        .webhooks.ingest(
          c.req.param('token'),
          raw,
          c.req.header('x-agentflow-signature'),
          c.req.header('x-agentflow-token') ?? c.req.query('token'),
        );
      return c.json(out, 202);
    } catch (e) {
      if (e instanceof UnauthorizedSignature) throw new UnauthorizedException(e.message);
      throw e;
    }
  });

  return r;
}

/** Recetas de disparador de un workflow (M19). Se monta bajo `/workflows/:workflowId/triggers`. */
export function workflowTriggersRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.post('/', requireScopes('workflow:write'), async (c) => {
    const b = await c.req.json<{ eventId: string; connectorId: string; params?: Record<string, unknown> }>();
    return c.json(await c.get('services').triggers.create(param(c, 'workflowId'), ws(c), b));
  });
  r.get('/', requireScopes('workflow:read'), async (c) =>
    c.json(await c.get('services').triggers.listByWorkflow(param(c, 'workflowId'), ws(c))),
  );

  return r;
}

/** Borrado de una receta por id (desregistra en el proveedor + limpia lo local). */
export function triggersAdminRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();
  r.delete('/:id', requireScopes('workflow:write'), async (c) =>
    c.json(await c.get('services').triggers.delete(c.req.param('id'), ws(c))),
  );
  return r;
}

/**
 * Ingreso PÚBLICO de eventos de Jira y Sentry (M19/M80). Jira autentica por el token del query —sus
 * webhooks dinámicos no admiten cabeceras—; Sentry por la firma HMAC del cuerpo. Ambos devuelven 202.
 */
export function providerHooksRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.post('/jira/:connectorId', async (c) => {
    const raw = await rawBody(c);
    return c.json(
      await c.get('services').triggers.ingestJiraEvent(param(c, 'connectorId'), c.req.query('token'), parseJson(raw)),
      202,
    );
  });

  r.post('/sentry', async (c) => {
    const raw = await rawBody(c);
    return c.json(
      await c
        .get('services')
        .triggers.ingestSentryEvent(raw, c.req.header('sentry-hook-signature'), c.req.header('sentry-hook-resource'), parseJson(raw)),
      202,
    );
  });

  return r;
}

/** Proyectos de Jira accesibles con un conector. Se monta bajo `/connectors/:connectorId/jira-projects`. */
export function jiraProjectsRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();
  r.get('/', requireScopes('workflow:read'), async (c) =>
    c.json(await c.get('services').triggers.jiraProjects(param(c, 'connectorId'), ws(c), c.req.query('cloudId'))),
  );
  return r;
}

/**
 * Compartir por enlace (M85). Las rutas del dueño exigen sesión; la LECTURA del enlace es pública —el
 * token de la URL es la credencial— y va con rate-limit. Se monta en la raíz porque sus rutas viven en
 * dos árboles (`/workflows/:id/share` y `/shares/...`).
 */
export function sharesRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.post('/workflows/:id/share', requireScopes('workflow:write'), async (c) => {
    const parsed = CreateShareRequestSchema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    return c.json(await c.get('services').shares.createShare(c.req.param('id'), ws(c), c.get('user').sub, parsed.data));
  });

  r.get('/shares', async (c) => c.json(await c.get('services').shares.list(ws(c))));

  // Pública: quien importa aún no tiene sesión. Rate-limit anti-abuso.
  r.get('/shares/:token', rateLimit(), async (c) => c.json(await c.get('services').shares.preview(c.req.param('token'))));

  r.post('/shares/:token/import', rateLimit(), async (c) =>
    c.json(await c.get('services').shares.importShare(c.req.param('token'), ws(c))),
  );

  r.delete('/shares/:token', async (c) => c.json(await c.get('services').shares.revoke(c.req.param('token'), ws(c))));

  return r;
}
