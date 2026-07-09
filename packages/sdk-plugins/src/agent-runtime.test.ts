import { describe, it, expect } from 'vitest';
import { emptyContext, type Agent, type MemoryScope } from '@core/contracts';
import { createLlmRouter } from '@core/llm';
import { AgentRuntime, type AgentRuntimeDeps } from './agent-runtime';
import { ToolRegistry, MockTool, HttpTool } from './tools';
import { ToolAuthorizationService } from './tool-authorization';

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'agent_1',
  name: 'QA',
  description: null,
  systemPrompt: 'Eres QA',
  model: 'mock-1',
  tools: [],
  memoryScope: null,
  variables: null,
  limits: null,
  permissions: { role: 'EDITOR' },
  isOrchestrator: false,
  ...over,
});

const deps = (memory?: AgentRuntimeDeps['memory']): AgentRuntimeDeps => ({
  router: createLlmRouter({ forceProvider: 'mock' }),
  tools: new ToolRegistry().register(new MockTool()).register(new HttpTool([])),
  authz: new ToolAuthorizationService(),
  memory,
});


const toolLog = (res: { context: { variables: Record<string, unknown> } }): any[] =>
  (res.context.variables['agent:QA'] as { tools: unknown[] }).tools as any[];

describe('AgentRuntime', () => {
  it('ejecuta y devuelve output + tokens + coste', async () => {
    const res = await new AgentRuntime(deps()).invoke(agent(), { ...emptyContext(), variables: { task: 'Resume el estado' } });
    expect(res.output).toContain('Mock');
    expect(res.tokens).toBeGreaterThan(0);
    expect(res.cost).toBeGreaterThanOrEqual(0);
  });

  it('ejecuta una tool autorizada (mock) cuando el LLM la pide', async () => {
    const res = await new AgentRuntime(deps()).invoke(agent({ tools: ['mock'] }), {
      ...emptyContext(),
      variables: { task: 'usa la tool mock con esto' },
    });
    const log = toolLog(res);
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].allowed).toBe(true);
  });

  it('rechaza una tool NO autorizada por RBAC (rol VIEWER) aunque esté en el allowlist', async () => {
    const res = await new AgentRuntime(deps()).invoke(agent({ tools: ['http'], permissions: { role: 'VIEWER' } }), {
      ...emptyContext(),
      variables: { task: 'usa http para https://example.com' },
    });
    const log = toolLog(res);
    expect(log[0].allowed).toBe(false);
  });

  it('expone y ejecuta las herramientas de un servidor MCP enganchado al agente (M40)', async () => {
    let resolvedWith: { ws: string; count: number } | null = null;
    let invoked = false;
    const mcp: AgentRuntimeDeps['mcp'] = {
      async resolve(ws, servers) {
        resolvedWith = { ws, count: servers.length };
        return [
          {
            name: 'GitHub_crear_issue',
            description: '[GitHub] crea un issue',
            parameters: {},
            invoke: async () => {
              invoked = true;
              return { ok: true };
            },
          },
        ];
      },
    };
    const a = agent({ tools: [], mcpServers: [{ id: 's1', name: 'GitHub', url: 'https://mcp.example/mcp' }] });
    const res = await new AgentRuntime({ ...deps(), mcp }).invoke(
      a,
      { ...emptyContext(), variables: { task: 'usa la herramienta para crear un issue' } },
      'ws1',
    );
    expect(resolvedWith).toEqual({ ws: 'ws1', count: 1 }); // se resolvió con el workspace + los servidores del agente
    expect(invoked).toBe(true); // el modelo pidió la tool MCP y se enrutó a su invoke
    const log = toolLog(res);
    expect(log.find((l) => l.tool === 'GitHub_crear_issue')?.allowed).toBe(true);
  });

  it('M76: DENIEGA una herramienta de integración con scope si el rol del agente no lo tiene (VIEWER)', async () => {
    let invoked = false;
    const mcp: AgentRuntimeDeps['mcp'] = {
      async resolve() {
        return [
          {
            name: 'jira_create_issue',
            description: 'crea un issue en Jira',
            parameters: {},
            scope: 'integration:write', // VIEWER no tiene integration:write
            invoke: async () => {
              invoked = true;
              return { ok: true };
            },
          },
        ];
      },
    };
    const a = agent({ tools: [], mcpServers: [{ id: 's1', name: 'Atlassian', url: 'integration://atlassian' }], permissions: { role: 'VIEWER' } });
    const res = await new AgentRuntime({ ...deps(), mcp }).invoke(a, { ...emptyContext(), variables: { task: 'usa la herramienta para crear un issue' } }, 'ws1');
    expect(invoked).toBe(false); // el guard RBAC impidió la invocación con el token de la plataforma
    const log = toolLog(res);
    expect(log.find((l) => l.tool === 'jira_create_issue')?.allowed).toBe(false);
  });

  it('M76: PERMITE la herramienta de integración con scope si el rol la concede (EDITOR)', async () => {
    let invoked = false;
    const mcp: AgentRuntimeDeps['mcp'] = {
      async resolve() {
        return [
          {
            name: 'jira_create_issue',
            description: 'crea un issue en Jira',
            parameters: {},
            scope: 'integration:write',
            invoke: async () => {
              invoked = true;
              return { ok: true };
            },
          },
        ];
      },
    };
    const a = agent({ tools: [], mcpServers: [{ id: 's1', name: 'Atlassian', url: 'integration://atlassian' }], permissions: { role: 'EDITOR' } });
    await new AgentRuntime({ ...deps(), mcp }).invoke(a, { ...emptyContext(), variables: { task: 'usa la herramienta para crear un issue' } }, 'ws1');
    expect(invoked).toBe(true);
  });

  it('escribe en memoria compartida tras responder', async () => {
    const writes: Array<{ scope: MemoryScope; key: string }> = [];
    const memory: AgentRuntimeDeps['memory'] = {
      async get() {
        return undefined;
      },
      async set() {},
      async append(scope, _ownerId, key) {
        writes.push({ scope, key });
      },
    };
    await new AgentRuntime(deps(memory)).invoke(agent(), { ...emptyContext(), variables: { task: 'hola' } });
    expect(writes).toEqual([{ scope: 'shared', key: 'notes' }]);
  });
});
