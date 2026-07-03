import { describe, it, expect } from 'vitest';
import { emptyContext, type Agent, type IAgentRuntime, type AgentResult, type ExecutionContext } from '@core/contracts';
import type { Plan, AgentSelectionStrategy } from '@core/domain';
import { DefaultPlanExecutor } from './plan-executor-impl';
import { CapabilitySelectionStrategy } from './capability-selection';

const agent = (id: string): Agent => ({
  id,
  name: id,
  description: null,
  systemPrompt: '',
  model: 'mock-1',
  tools: [],
  memoryScope: null,
  variables: null,
  limits: null,
  permissions: { role: 'EDITOR' },
  isOrchestrator: false,
});

const okRuntime = (): IAgentRuntime => ({
  async invoke(a: Agent, ctx: ExecutionContext): Promise<AgentResult> {
    return { context: { ...ctx, variables: { ...ctx.variables, [`out:${a.id}`]: 'done' } }, output: `out-${a.id}`, tokens: 10, cost: 0.001 };
  },
});

// Fan-out: s1 -> {s2, s3}
const fanOutPlan = (): Plan => ({
  id: 'p',
  subtasks: [
    { id: 's1', agentId: 'a', task: 't1' },
    { id: 's2', agentId: 'b', task: 't2' },
    { id: 's3', agentId: 'c', task: 't3' },
  ],
  edges: [
    { source: 's1', target: 's2' },
    { source: 's1', target: 's3' },
  ],
});
const agents = () => new Map([['a', agent('a')], ['b', agent('b')], ['c', agent('c')]]);

describe('DefaultPlanExecutor (M5 sub-DAG)', () => {
  it('sequential y durable/paralelo dan el MISMO resultado y contexto (determinismo)', async () => {
    const noop = () => {};
    const seq = await new DefaultPlanExecutor(okRuntime(), { mode: 'sequential' }).execute(fanOutPlan(), emptyContext(), agents(), noop);
    const dur = await new DefaultPlanExecutor(okRuntime(), { mode: 'durable' }).execute(fanOutPlan(), emptyContext(), agents(), noop);
    expect(dur.results).toEqual(seq.results);
    expect(dur.context.variables).toEqual(seq.context.variables);
    expect(dur.totalTokens).toBe(30);
  });

  it('reintenta una subtarea transitoriamente fallida hasta tener éxito', async () => {
    let calls = 0;
    const flaky: IAgentRuntime = {
      async invoke(_a, ctx) {
        calls++;
        if (calls < 2) throw new Error('fallo transitorio');
        return { context: ctx, output: 'ok', tokens: 1, cost: 0 };
      },
    };
    const p: Plan = { id: 'p', subtasks: [{ id: 's1', agentId: 'a', task: 't' }], edges: [] };
    const res = await new DefaultPlanExecutor(flaky, { mode: 'durable', subtaskPolicy: { maxAttempts: 3, backoffMs: 1 } }).execute(
      p,
      emptyContext(),
      agents(),
      () => {},
    );
    expect(res.results.s1).toBe('ok');
    expect(calls).toBe(2);
  });

  it('usa la AgentSelectionStrategy pluggable para elegir el agente', async () => {
    const seen: string[] = [];
    const rt: IAgentRuntime = {
      async invoke(a, ctx) {
        seen.push(a.id);
        return { context: ctx, output: '', tokens: 0, cost: 0 };
      },
    };
    const strategy: AgentSelectionStrategy = { async selectAgent(_subtask, m) { return m.get('c') ?? null; } };
    const p: Plan = { id: 'p', subtasks: [{ id: 's1', agentId: 'a', task: 't' }], edges: [] };
    await new DefaultPlanExecutor(rt, { mode: 'durable', selectionStrategy: strategy }).execute(p, emptyContext(), agents(), () => {});
    expect(seen).toEqual(['c']); // la estrategia redirigió 'a' -> 'c'
  });

  it('emite subtask.failed + plan.execution_failed y rechaza si el agente no existe', async () => {
    const events: Array<{ type: string }> = [];
    const p: Plan = { id: 'p', subtasks: [{ id: 's1', agentId: 'ghost', task: 't' }], edges: [] };
    await expect(
      new DefaultPlanExecutor(okRuntime(), { mode: 'durable' }).execute(p, emptyContext(), agents(), (e) => events.push(e as { type: string })),
    ).rejects.toThrow();
    expect(events.some((e) => e.type === 'subtask.failed')).toBe(true);
    expect(events.some((e) => e.type === 'plan.execution_failed')).toBe(true);
  });

  it('respeta la política de reintentos POR subtarea (override del default)', async () => {
    let calls = 0;
    const flaky: IAgentRuntime = {
      async invoke(_a, ctx) {
        calls++;
        if (calls < 3) throw new Error('transitorio');
        return { context: ctx, output: 'ok', tokens: 1, cost: 0 };
      },
    };
    // default maxAttempts=1, pero la subtarea pide 3.
    const p: Plan = { id: 'p', subtasks: [{ id: 's1', agentId: 'a', task: 't', policy: { maxAttempts: 3, backoffMs: 1 } }], edges: [] };
    const res = await new DefaultPlanExecutor(flaky, { mode: 'durable' }).execute(p, emptyContext(), agents(), () => {});
    expect(res.results.s1).toBe('ok');
    expect(calls).toBe(3);
  });

  it('aborta el plan al exceder el PRESUPUESTO global de tokens', async () => {
    const events: Array<{ type: string }> = [];
    // Cada subtarea gasta 10 tokens; budget=15 → tras s1 (10) sigue; tras nivel s2/s3 (30) aborta.
    const p = fanOutPlan();
    await expect(
      new DefaultPlanExecutor(okRuntime(), { mode: 'durable', budget: { maxTokens: 15 } }).execute(
        p,
        emptyContext(),
        agents(),
        (e) => events.push(e as { type: string }),
      ),
    ).rejects.toThrow(/[Pp]resupuesto/);
    expect(events.some((e) => e.type === 'plan.budget_exceeded')).toBe(true);
    expect(events.some((e) => e.type === 'plan.execution_failed')).toBe(true);
  });

  it('selección por capacidades: redirige a un agente que cubra `requires`', async () => {
    const seen: string[] = [];
    const rt: IAgentRuntime = {
      async invoke(a, ctx) {
        seen.push(a.id);
        return { context: ctx, output: '', tokens: 0, cost: 0 };
      },
    };
    const withTool = (id: string, tools: string[]) => ({ ...agent(id), tools });
    const map = new Map([
      ['a', withTool('a', [])], // pedido pero SIN la capacidad
      ['b', withTool('b', ['http'])], // capaz
    ]);
    const p: Plan = { id: 'p', subtasks: [{ id: 's1', agentId: 'a', task: 't', requires: ['http'] }], edges: [] };
    await new DefaultPlanExecutor(rt, { mode: 'durable', selectionStrategy: new CapabilitySelectionStrategy() }).execute(p, emptyContext(), map, () => {});
    expect(seen).toEqual(['b']); // 'a' no cubre 'http' → redirige a 'b'
  });

  it('handoff con mínimo privilegio: el subagente solo ve las variables autorizadas', async () => {
    let receivedVars: Record<string, unknown> = {};
    const rt: IAgentRuntime = {
      async invoke(_a, ctx) {
        receivedVars = ctx.variables;
        return { context: ctx, output: '', tokens: 0, cost: 0 };
      },
    };
    const ctx: ExecutionContext = { ...emptyContext(), variables: { publico: 'ok', 'agent:secreto': 'no' } };
    const p: Plan = { id: 'p', subtasks: [{ id: 's1', agentId: 'a', task: 'haz X', handoff: { variableKeys: ['publico'] } }], edges: [] };
    await new DefaultPlanExecutor(rt, { mode: 'durable' }).execute(p, ctx, agents(), () => {});
    expect(receivedVars).toEqual({ publico: 'ok', task: 'haz X' }); // 'agent:secreto' NO viaja
  });
});
