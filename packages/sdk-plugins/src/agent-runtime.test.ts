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
