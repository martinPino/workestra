import { Hono, type Context } from 'hono';
import { AnalyticsBatchSchema, EventNameSchema, EntityTypeSchema, type AnalyticsRange } from '@core/contracts';
import { BadRequestException, ForbiddenException } from '../common';
import { requireScopes } from '../scopes.middleware';
import { analyticsEnabled } from '../../analytics/analytics.service';
import { ws, type RouterEnv } from './types';

/**
 * Analítica de producto (M84): port de `IngestController`, `InsightsController` y
 * `PlatformInsightsController`.
 *
 * Se mantienen los TRES prefijos originales y sus permisos, que comprueban cosas distintas:
 *  - `/ingest`   — escribe. Sesión, sin scope: cualquiera que use el producto genera su telemetría.
 *  - `/insights` — lee lo del propio workspace. `analytics:read` (OWNER/ADMIN).
 *  - `/insights/platform` — cruza TODOS los clientes. Además, administrador de PLATAFORMA.
 */

/**
 * INGESTA. La ruta se llama `/ingest` y no `/analytics` a propósito: las listas de bloqueo de anuncios
 * cazan por nombre cualquier URL que contenga «analytics», «track» o «collect», y un usuario con un
 * bloqueador puesto desaparecería entero de las métricas sin que nadie se enterase.
 */
export function ingestRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  /**
   * Si la analítica está encendida. PÚBLICO (ver `public-routes.ts`) porque el navegador lo consulta
   * antes de saber quién es y porque no revela nada: solo dice si hay telemetría.
   *
   * Es la pieza que de verdad ahorra: con esto el navegador ni arranca el reloj ni escucha eventos ni
   * manda nada.
   */
  r.get('/config', (c) => c.json({ enabled: analyticsEnabled() }));

  /**
   * 202: aceptado. El navegador no espera resultado —manda y sigue—, así que devolver el detalle no
   * aporta nada y sí invitaría a que el cliente reintentase por cosas que no son suyas.
   */
  r.post('/', async (c) => {
    const parsed = AnalyticsBatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestException('Lote inválido.');
    const user = c.get('user');
    const res = await c.get('services').analytics.ingest(parsed.data, ws(c), user?.sub ?? '');
    return c.json({ accepted: res.accepted }, 202);
  });

  return r;
}

/**
 * PANEL. Dos capas de permiso que comprueban cosas DISTINTAS y hacen falta las dos:
 *  - `analytics:read` (OWNER/ADMIN) dice quién puede ver analítica. No es un permiso de tenant.
 *  - el filtro por workspace, que sale siempre de la sesión verificada.
 * Y encima, `?scope=all` (cruzar todos los clientes) exige además ser administrador de PLATAFORMA.
 */
export function insightsRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.use('*', requireScopes('analytics:read'));

  /**
   * Qué puede ver quien pregunta. El nav del front se apoya en esto; la API lo exige igual.
   * Se devuelve también si la recogida está encendida: con el interruptor apagado, un panel a cero no
   * es una medición —es que no se está midiendo—, y el panel tiene que poder decirlo.
   */
  r.get('/me', async (c) => {
    const s = c.get('services');
    return c.json({
      platformAdmin: await s.platformAdmin.isAdmin(c.get('user')?.sub),
      collecting: analyticsEnabled(),
    });
  });

  /**
   * Resumen cruzando TODOS los workspaces. Va ANTES de `/overview` porque Hono casa por orden y
   * `/platform/overview` no debe caer en el handler del propio workspace.
   *
   * Es la única puerta explícita de plataforma: aquí no hay `?scope=all` que valga, se exige el
   * permiso y punto.
   */
  r.get('/platform/overview', async (c) => {
    const s = c.get('services');
    if (!(await s.platformAdmin.isAdmin(c.get('user')?.sub))) {
      throw new ForbiddenException('Se requiere ser administrador de plataforma.');
    }
    const q = c.req.query();
    const to = new Date();
    const days = clamp(Number(q.days), 1, 180, 30);
    return c.json(
      await s.analytics.overview({
        workspaceId: 'ALL',
        from: new Date(to.getTime() - days * 86_400_000).toISOString(),
        to: to.toISOString(),
        limit: clamp(Number(q.limit), 1, 200, 20),
      }),
    );
  });

  r.get('/overview', async (c) => c.json(await c.get('services').analytics.overview(await range(c))));

  r.get('/entities', async (c) => {
    const q = c.req.query();
    const name = EventNameSchema.safeParse(q.name);
    const entityType = EntityTypeSchema.safeParse(q.entityType);
    if (!name.success || !entityType.success) throw new BadRequestException('Evento o tipo de entidad desconocido.');
    return c.json(
      await c.get('services').analytics.entities({ ...(await range(c)), name: name.data, entityType: entityType.data }),
    );
  });

  r.get('/features', async (c) => c.json(await c.get('services').analytics.features(await range(c))));

  r.get('/retention', async (c) =>
    c.json(
      await c.get('services').analytics.retention({
        ...(await range(c)),
        cohortDays: clamp(Number(c.req.query('cohortDays')), 1, 90, 30),
      }),
    ),
  );

  r.get('/search', async (c) => c.json(await c.get('services').analytics.search(await range(c))));

  /**
   * Embudo. Los pasos vienen del cliente pero SOLO pueden ser nombres del catálogo cerrado: así el
   * panel es flexible sin que nadie pueda colar SQL ni inventarse cardinalidad.
   */
  r.get('/funnel', async (c) => {
    const q = c.req.query();
    const parsed = (q.steps ?? '').split(',').map((s) => EventNameSchema.safeParse(s.trim()));
    if (parsed.length < 2 || parsed.some((s) => !s.success)) throw new BadRequestException('Pasos del embudo inválidos.');
    return c.json(
      await c.get('services').analytics.funnel({
        ...(await range(c)),
        steps: parsed.map((s) => (s as { success: true; data: never }).data),
        windowMinutes: clamp(Number(q.windowMinutes), 1, 1440, 60),
      }),
    );
  });

  return r;
}

/** Acota un número de la query a un rango, con valor por defecto si no es un número usable. */
function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * Construye la ventana. Aquí se decide el tenant, y es el punto donde un error se convierte en fuga
 * entre clientes: `ALL` solo se alcanza siendo administrador de plataforma; en cualquier otro caso se
 * usa el workspace de la sesión verificada, nunca algo que venga en la query.
 */
async function range(c: Context<RouterEnv>): Promise<AnalyticsRange> {
  const q = c.req.query();
  const all = q.scope === 'all';
  if (all && !(await c.get('services').platformAdmin.isAdmin(c.get('user')?.sub))) {
    throw new BadRequestException('Ámbito no disponible.');
  }
  const to = q.to && !Number.isNaN(Date.parse(q.to)) ? new Date(q.to) : new Date();
  const days = clamp(Number(q.days), 1, 180, 30);
  const from = q.from && !Number.isNaN(Date.parse(q.from)) ? new Date(q.from) : new Date(to.getTime() - days * 86_400_000);
  return {
    workspaceId: all ? 'ALL' : ws(c),
    from: from.toISOString(),
    to: to.toISOString(),
    limit: clamp(Number(q.limit), 1, 200, 20),
  };
}
