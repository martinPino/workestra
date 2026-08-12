import { Hono } from 'hono';
import { requireScopes } from '../scopes.middleware';
import { ws, type RouterEnv } from './types';

/** Rutas de workflows: port de `WorkflowsController`. */
export function workflowsRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.post('/', requireScopes('workflow:write'), async (c) =>
    c.json(await c.get('services').workflows.create(await c.req.json(), ws(c))),
  );

  // «Construir con IA» (M29). Con workflow:write porque genera vía LLM (operación con coste).
  // Va antes que `/:id` — si no, `POST /workflows/generate` no llegaría aquí nunca.
  r.post('/generate', requireScopes('workflow:write'), async (c) => {
    const b = await c.req.json<{ prompt?: string; model?: string }>();
    return c.json(await c.get('services').workflows.generate(b?.prompt ?? '', ws(c), b?.model));
  });

  // «Chat con IA en el editor» (M30): modifica el grafo actual según una instrucción.
  r.post('/edit', requireScopes('workflow:write'), async (c) => {
    const b = await c.req.json<{ prompt?: string; graph?: unknown; model?: string }>();
    return c.json(await c.get('services').workflows.editGraph(b?.graph, b?.prompt ?? '', ws(c), b?.model));
  });

  // «Chat consciente del contexto» (M36): decide entre editar el grafo o responder.
  r.post('/chat', requireScopes('workflow:write'), async (c) => {
    const b = await c.req.json<{
      message?: string;
      graph?: unknown;
      name?: string;
      notes?: string[];
      selected?: string;
      model?: string;
      page?: string;
    }>();
    return c.json(
      await c.get('services').workflows.chatGraph(b?.graph, b?.message ?? '', ws(c), {
        name: b?.name,
        notes: b?.notes,
        selected: b?.selected,
        model: b?.model,
        page: b?.page,
      }),
    );
  });

  r.get('/', async (c) => c.json(await c.get('services').workflows.list(ws(c))));
  r.get('/:id', async (c) => c.json(await c.get('services').workflows.get(c.req.param('id'), ws(c))));
  r.get('/:id/versions', async (c) => c.json(await c.get('services').workflows.listVersions(c.req.param('id'), ws(c))));

  r.put('/:id/graph', requireScopes('workflow:write'), async (c) =>
    c.json(await c.get('services').workflows.saveGraph(c.req.param('id'), await c.req.json(), ws(c))),
  );

  r.post('/:id/publish', requireScopes('workflow:write'), async (c) =>
    c.json(await c.get('services').workflows.publish(c.req.param('id'), ws(c))),
  );

  // `workflow:delete`, NO `workflow:write`: borra todo el historial de versiones y ejecuciones, así que
  // es de ADMIN/OWNER. Confundirlo con `write` daría a un EDITOR permiso para destruirlo todo.
  r.delete('/:id', requireScopes('workflow:delete'), async (c) =>
    c.json(await c.get('services').workflows.remove(c.req.param('id'), ws(c))),
  );

  return r;
}
