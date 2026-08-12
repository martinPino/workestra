import { Hono } from 'hono';
import { workspaceOf, type AuthVariables } from '../auth.middleware';
import { requireScopes } from '../scopes.middleware';
import type { Services } from '../services';

/** El contexto que este router necesita: el principal autenticado y los servicios de la petición. */
type RouterEnv = { Variables: AuthVariables & { services: Services } };

/**
 * Rutas de agentes: port de `AgentsController`.
 *
 * Es el patrón para los 13 controllers restantes. Tres cosas que hay que respetar al portar:
 *
 *  1. **Los scopes viajan con la ruta.** Cada `@RequireScopes(...)` pasa a un `requireScopes(...)` en su
 *     ruta. Es el único riesgo real del port: perder uno no rompe ningún test y abre una escritura a
 *     VIEWER.
 *  2. **El orden importa.** Hono casa por orden de declaración, así que las rutas literales
 *     (`/mcp/verify`) van ANTES que las paramétricas (`/:id`). En Nest daba igual; aquí, si se invierte,
 *     `POST /agents/mcp/connect` acaba en el handler de `:id`.
 *  3. **El workspace sale del principal**, nunca de la petición: `workspaceOf(c.get('user'))` es el
 *     equivalente exacto del decorador `@Workspace()`.
 */
export function agentsRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.get('/', (c) => c.json(c.get('services').agents.list(workspaceOf(c.get('user')))));

  // «Crear asistente con IA» (M68): la persona describe el asistente y la IA devuelve un borrador.
  r.post('/chat', requireScopes('agent:write'), async (c) => {
    const body = await c.req.json<{ message?: string; model?: string }>().catch(() => ({}) as { message?: string; model?: string });
    return c.json(await c.get('services').agents.chatDraft(body?.message ?? '', workspaceOf(c.get('user')), { model: body?.model }));
  });

  // Verifica un servidor MCP (M43/M45): se conecta y lista sus tools. Antes de `/:id` a propósito.
  r.post('/mcp/verify', async (c) => {
    const body = await c.req.json<{ url?: string; serverId?: string }>().catch(() => ({}) as { url?: string; serverId?: string });
    return c.json(await c.get('services').agents.verifyMcp(body?.url ?? '', workspaceOf(c.get('user')), body?.serverId));
  });

  // «Conectar» un servidor MCP (M45): guarda su credencial cifrada. MUTA: no para VIEWER.
  r.post('/mcp/connect', requireScopes('agent:write'), async (c) => {
    const body = await c.req.json<{ serverId?: string; token?: string }>().catch(() => ({}) as { serverId?: string; token?: string });
    return c.json(await c.get('services').agents.connectMcp(workspaceOf(c.get('user')), body?.serverId ?? '', body?.token ?? ''));
  });

  r.delete('/mcp/connect/:serverId', requireScopes('agent:write'), async (c) =>
    c.json(await c.get('services').agents.disconnectMcp(workspaceOf(c.get('user')), c.req.param('serverId'))),
  );

  r.get('/:id', async (c) => c.json(await c.get('services').agents.get(c.req.param('id'), workspaceOf(c.get('user')))));

  r.post('/', requireScopes('agent:write'), async (c) =>
    c.json(await c.get('services').agents.create(await c.req.json(), workspaceOf(c.get('user')))),
  );

  r.patch('/:id', requireScopes('agent:write'), async (c) =>
    c.json(await c.get('services').agents.update(c.req.param('id'), await c.req.json(), workspaceOf(c.get('user')))),
  );

  r.delete('/:id', requireScopes('agent:write'), async (c) =>
    c.json(await c.get('services').agents.remove(c.req.param('id'), workspaceOf(c.get('user')))),
  );

  return r;
}
