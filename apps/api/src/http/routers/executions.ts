import { Hono } from 'hono';
import { requireScopes } from '../scopes.middleware';
import { ws, type RouterEnv } from './types';

/**
 * Rutas de ejecuciones: port de `ExecutionsController` y `HumanEscalationController`.
 *
 * Los dos controllers de Nest se fusionan aquí porque cuelgan del mismo prefijo (`executions` y
 * `executions/:id`) y en Hono un solo router los cubre. El orden entre `/:id/...` y `/:id` sigue
 * importando: las rutas con sufijo van primero.
 */
export function executionsRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  // Lanzar MUTA (crea un run y consume IA): `execution:create` es EDITOR+. Un VIEWER no ejecuta.
  r.post('/', requireScopes('execution:create'), async (c) => {
    const b = await c.req.json<{ workflowId: string; context?: Record<string, unknown> }>();
    return c.json(await c.get('services').executions.start(b.workflowId, ws(c), b.context));
  });

  r.get('/', async (c) => {
    const limit = c.req.query('limit');
    return c.json(
      await c.get('services').executions.list(ws(c), {
        status: c.req.query('status'),
        limit: limit ? Number(limit) : undefined,
        workflowId: c.req.query('workflowId'),
      }),
    );
  });

  /** Delta del stream (M9): solo los `seq > since`, para el poll incremental de la consola. */
  r.get('/:id/events', async (c) => {
    const since = c.req.query('since');
    return c.json(await c.get('services').executions.listEvents(c.req.param('id'), ws(c), since != null ? Number(since) : -1));
  });

  /**
   * Artefacto de la ejecución (M72). Se devuelve como data URL en JSON y no como binario porque el
   * endpoint va autenticado con Bearer y un `<img src>` directo no llevaría la cabecera.
   *
   * `Buffer` sigue disponible gracias a `nodejs_compat`; se usa el mismo camino que en Node para no
   * cambiar el formato de salida.
   */
  r.get('/:id/files/:fileId', async (c) => {
    const f = await c.get('services').executions.getFile(c.req.param('id'), ws(c), c.req.param('fileId'));
    const base64 = Buffer.from(f.bytes).toString('base64');
    return c.json({ name: f.name, mimeType: f.mimeType, dataUrl: `data:${f.mimeType};base64,${base64}` });
  });

  r.get('/:id/reviews', async (c) => c.json(await c.get('services').humanEscalation.listReviews(c.req.param('id'), ws(c))));

  r.post('/:id/human', requireScopes('execution:approve'), async (c) => {
    const b = await c.req.json<{ approved?: boolean; decision?: string; reviewId?: string; resolvedBy?: string }>();
    // Quien resuelve sale del principal si el cuerpo no lo dice; nunca queda sin atribuir.
    const resolvedBy = b.resolvedBy ?? c.get('user')?.sub ?? 'unknown';
    return c.json(
      await c.get('services').humanEscalation.resolveReview(c.req.param('id'), ws(c), {
        approved: Boolean(b.approved),
        decision: b.decision,
        reviewId: b.reviewId,
        resolvedBy,
      }),
    );
  });

  r.get('/:id', async (c) => c.json(await c.get('services').executions.get(c.req.param('id'), ws(c))));

  return r;
}
