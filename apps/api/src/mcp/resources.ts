import { ResourceTemplate } from './mcp-sdk';
import type { McpServerLike, McpResourceResult } from './mcp-sdk';
import type { McpContext } from './tools';

function jsonRes(uri: URL, data: unknown): McpResourceResult {
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}

/**
 * Resources MCP de solo lectura (M32): dan CONTEXTO sin ejecutar acciones. URIs `workflow://{id}`,
 * `agent://{id}`, `execution://{id}`, `connector://{id}`. Los que tienen `list` aparecen en resources/list.
 * Todo acotado al workspace del principal.
 */
export function registerResources(server: McpServerLike, ctx: McpContext): void {
  const ws = ctx.principal.workspaceId;

  server.registerResource(
    'workflow',
    new ResourceTemplate('workflow://{id}', {
      list: async () => {
        const wfs = (await ctx.workflows.list(ws)) as Array<{ id: string; name: string }>;
        return { resources: wfs.map((w) => ({ name: w.name, uri: `workflow://${w.id}` })) };
      },
    }),
    { title: 'Automatización', description: 'Una automatización con su grafo.', mimeType: 'application/json' },
    async (uri, vars) => jsonRes(uri, await ctx.workflows.get(String(vars.id), ws)),
  );

  server.registerResource(
    'agent',
    new ResourceTemplate('agent://{id}', {
      list: async () => {
        const agents = (await ctx.agents.list(ws)) as Array<{ id: string; name: string }>;
        return { resources: agents.map((a) => ({ name: a.name, uri: `agent://${a.id}` })) };
      },
    }),
    { title: 'Agente', description: 'Un agente del workspace.', mimeType: 'application/json' },
    async (uri, vars) => jsonRes(uri, await ctx.agents.get(String(vars.id), ws)),
  );

  server.registerResource(
    'execution',
    new ResourceTemplate('execution://{id}', { list: undefined }),
    { title: 'Ejecución', description: 'Estado y eventos de una ejecución.', mimeType: 'application/json' },
    async (uri, vars) => jsonRes(uri, await ctx.executions.get(String(vars.id), ws)),
  );

  server.registerResource(
    'connector',
    new ResourceTemplate('connector://{id}', {
      list: async () => {
        const conns = (await ctx.connectors.list(ws)) as Array<{ id: string; key?: string; provider: string }>;
        return { resources: conns.map((c) => ({ name: c.key ?? c.provider, uri: `connector://${c.id}` })) };
      },
    }),
    { title: 'Conector', description: 'Una integración conectada.', mimeType: 'application/json' },
    async (uri, vars) => {
      const conns = (await ctx.connectors.list(ws)) as Array<{ id: string }>;
      const found = conns.find((c) => c.id === String(vars.id));
      if (!found) throw new Error(`Conector no encontrado: ${String(vars.id)}`);
      return jsonRes(uri, found);
    },
  );
}
