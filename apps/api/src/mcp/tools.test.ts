import { describe, it, expect } from 'vitest';
import type { Role } from '@core/contracts';
import { RbacService } from '../rbac/rbac.service';
import { registerTools, type McpContext } from './tools';
import type { McpServerLike, McpToolResult } from './mcp-sdk';

/** Servidor MCP falso: captura los handlers registrados para invocarlos en el test. */
function fakeServer() {
  const handlers = new Map<string, (args: unknown) => Promise<McpToolResult>>();
  const server = {
    registerTool: (name: string, _cfg: unknown, cb: (args: unknown) => Promise<McpToolResult>) => handlers.set(name, cb),
    registerResource: () => undefined,
    registerPrompt: () => undefined,
    connect: async () => undefined,
  } as unknown as McpServerLike;
  return { server, call: (n: string, a: Record<string, unknown> = {}) => handlers.get(n)!(a) };
}

function mkCtx(role: Role) {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string) => (...args: unknown[]) => { calls[name] = args; return { ok: name }; };
  const ctx: McpContext = {
    principal: { sub: 'u', email: 'e@x.c', role, workspaceId: 'ws_1' },
    // solo los métodos que tocan las tools bajo prueba
    workflows: { list: rec('wf.list'), get: rec('wf.get'), create: rec('wf.create'), saveGraph: rec('wf.save'), publish: rec('wf.pub'), remove: rec('wf.remove') } as unknown as McpContext['workflows'],
    agents: { list: rec('ag.list'), create: rec('ag.create'), update: rec('ag.update'), remove: rec('ag.remove') } as unknown as McpContext['agents'],
    executions: { start: rec('ex.start'), list: rec('ex.list'), get: rec('ex.get') } as unknown as McpContext['executions'],
    connectors: { list: rec('cn.list') } as unknown as McpContext['connectors'],
    rbac: new RbacService(),
  };
  return { ctx, calls };
}

describe('MCP tools (M32)', () => {
  it('cada tool llama a su servicio con el workspaceId del principal', async () => {
    const { ctx, calls } = mkCtx('OWNER');
    const { server, call } = fakeServer();
    registerTools(server, ctx);

    await call('create_workflow', { name: 'X', graph: { nodes: [], edges: [] } });
    expect(calls['wf.create']).toEqual([{ name: 'X', graph: { nodes: [], edges: [] } }, 'ws_1']);

    await call('run_workflow', { workflowId: 'wf_9', context: { a: 1 } });
    expect(calls['ex.start']).toEqual(['wf_9', 'ws_1', { a: 1 }, 'manual']);

    await call('create_agent', { name: 'Bot', model: 'mock-1' });
    expect(calls['ag.create']).toEqual([{ name: 'Bot', model: 'mock-1' }, 'ws_1']);

    await call('delete_workflow', { id: 'wf_9' });
    expect(calls['wf.remove']).toEqual(['wf_9', 'ws_1']);
  });

  it('whoami devuelve el principal sin tocar servicios', async () => {
    const { ctx } = mkCtx('EDITOR');
    const { server, call } = fakeServer();
    registerTools(server, ctx);
    const r = await call('whoami');
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('ws_1');
  });

  it('RBAC: un VIEWER no puede borrar (isError) pero sí listar', async () => {
    const { ctx, calls } = mkCtx('VIEWER');
    const { server, call } = fakeServer();
    registerTools(server, ctx);

    const del = await call('delete_workflow', { id: 'wf_1' });
    expect(del.isError).toBe(true);
    expect(del.content[0].text).toMatch(/scope/i);
    expect(calls['wf.remove']).toBeUndefined(); // no llegó a llamar al servicio

    const list = await call('list_workflows');
    expect(list.isError).toBeFalsy();
    expect(calls['wf.list']).toEqual(['ws_1']);
  });

  it('un error del servicio se devuelve como isError, no se relanza', async () => {
    const { ctx } = mkCtx('OWNER');
    ctx.workflows.get = (() => { throw new Error('boom 429'); }) as unknown as McpContext['workflows']['get'];
    const { server, call } = fakeServer();
    registerTools(server, ctx);
    const r = await call('get_workflow', { id: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('boom 429');
  });
});
