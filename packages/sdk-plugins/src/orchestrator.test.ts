import { describe, it, expect } from 'vitest';
import { emptyContext, type Agent } from '@core/contracts';
import type { IAgentRepository } from '@core/engine';
import type { Plan } from '@core/domain';
import { createLlmRouter } from '@core/llm';
import { Orchestrator } from './orchestrator';
import { AgentRuntime } from './agent-runtime';
import { ToolRegistry } from './tools';
import { ToolAuthorizationService } from './tool-authorization';
import { LlmPlanner, type Planner } from './planner';

const worker = (id: string, name: string): Agent => ({
  id,
  name,
  description: null,
  systemPrompt: 'trabajador',
  model: 'mock-1',
  tools: [],
  memoryScope: null,
  variables: null,
  limits: null,
  permissions: { role: 'EDITOR' },
  isOrchestrator: false,
});

const orch: Agent = { ...worker('o', 'Orchestrator'), systemPrompt: 'coordina', permissions: { role: 'ADMIN' }, isOrchestrator: true };

function repo(agents: Agent[]): IAgentRepository {
  return {
    async list() {
      return agents;
    },
    async get(id) {
      return agents.find((a) => a.id === id) ?? null;
    },
    async getInWorkspace(id) {
      return agents.find((a) => a.id === id) ?? null;
    },
    async create(a) {
      return { id: 'x', ...a } as Agent;
    },
  };
}

const runtime = () =>
  new AgentRuntime({
    router: createLlmRouter({ forceProvider: 'mock' }),
    tools: new ToolRegistry(),
    authz: new ToolAuthorizationService(),
  });

const fixedPlanner = (plan: Plan): Planner => ({ async buildPlan() { return plan; } });

type Ev = { type: string; [k: string]: unknown };

describe('Orchestrator', () => {
  it('planifica, valida, ejecuta subtareas y fusiona; emite los eventos del plan', async () => {
    const agents = [worker('a1', 'QA'), worker('a2', 'Backend')];
    const plan: Plan = {
      id: 'p1',
      subtasks: [
        { id: 'st1', agentId: 'a1', task: 't1' },
        { id: 'st2', agentId: 'a2', task: 't2' },
      ],
      edges: [{ source: 'st1', target: 'st2' }],
    };
    const events: Ev[] = [];
    const o = new Orchestrator({ planner: fixedPlanner(plan), agents: repo([orch, ...agents]), runtime: runtime() });
    const res = await o.run(orch, { ...emptyContext(), variables: { task: 'coordina esto' } }, (e) => events.push(e as Ev), 'ws');

    const types = events.map((e) => e.type);
    expect(types).toContain('plan.created');
    expect(types.filter((t) => t === 'subtask.succeeded')).toHaveLength(2);
    expect(types).toContain('results.merged');
    expect(res.output).toContain('2 subtareas');
  });

  it('rechaza un plan CÍCLICO y agota los reintentos acotados', async () => {
    const agents = [worker('a1', 'QA'), worker('a2', 'Backend')];
    const cyclic: Plan = {
      id: 'bad',
      subtasks: [
        { id: 'st1', agentId: 'a1', task: 't' },
        { id: 'st2', agentId: 'a2', task: 't' },
      ],
      edges: [
        { source: 'st1', target: 'st2' },
        { source: 'st2', target: 'st1' },
      ],
    };
    const events: Ev[] = [];
    const o = new Orchestrator({ planner: fixedPlanner(cyclic), agents: repo([orch, ...agents]), runtime: runtime(), maxRepairs: 1 });
    await expect(
      o.run(orch, { ...emptyContext(), variables: { task: 'x' } }, (e) => events.push(e as Ev), 'ws'),
    ).rejects.toThrow();
    expect(events.filter((e) => e.type === 'plan.validation_failed')).toHaveLength(2); // maxRepairs + 1
  });

  it('integración con LlmPlanner+mock: plan válido de 2 agentes', async () => {
    const agents = [worker('a1', 'QA'), worker('a2', 'Backend')];
    const planner = new LlmPlanner(createLlmRouter({ forceProvider: 'mock' }), 'mock-1');
    const events: Ev[] = [];
    const o = new Orchestrator({ planner, agents: repo([orch, ...agents]), runtime: runtime() });
    const res = await o.run(orch, { ...emptyContext(), variables: { task: 'analiza y prueba' } }, (e) => events.push(e as Ev), 'ws');

    const created = events.find((e) => e.type === 'plan.created');
    expect(created?.subtasks as unknown[]).toHaveLength(2);
    expect(res.output).toContain('2 subtareas');
  });
});
