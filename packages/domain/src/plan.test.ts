import { describe, it, expect } from 'vitest';
import type { ExecutionEvent } from '@core/contracts';
import { validatePlan, reduceExecution, type Plan } from './index';

const agents = ['a1', 'a2'];

describe('validatePlan (de-riesga el riesgo #1 del Orchestrator)', () => {
  it('acepta un plan DAG con agentes existentes', () => {
    const plan: Plan = {
      id: 'p',
      subtasks: [
        { id: 's1', agentId: 'a1', task: 'x' },
        { id: 's2', agentId: 'a2', task: 'y' },
      ],
      edges: [{ source: 's1', target: 's2' }],
    };
    expect(validatePlan(plan, agents).valid).toBe(true);
  });

  it('rechaza un plan CÍCLICO', () => {
    const plan: Plan = {
      id: 'p',
      subtasks: [
        { id: 's1', agentId: 'a1', task: 'x' },
        { id: 's2', agentId: 'a2', task: 'y' },
      ],
      edges: [
        { source: 's1', target: 's2' },
        { source: 's2', target: 's1' },
      ],
    };
    const r = validatePlan(plan, agents);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'CYCLE')).toBe(true);
  });

  it('rechaza un plan con AGENTE INEXISTENTE', () => {
    const plan: Plan = { id: 'p', subtasks: [{ id: 's1', agentId: 'ghost', task: 'x' }], edges: [] };
    const r = validatePlan(plan, agents);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'UNKNOWN_AGENT')).toBe(true);
  });
});

const V = 1 as const;
const ev = (seq: number, p: { type: ExecutionEvent['type'] } & Record<string, unknown>): ExecutionEvent =>
  ({ schemaVersion: V, executionId: 'e', at: '2026-01-01T00:00:00.000Z', seq, ...p }) as ExecutionEvent;

describe('reducer proyecta el árbol de subtareas', () => {
  it('plan.created + subtask.* + results.merged', () => {
    const events: ExecutionEvent[] = [
      ev(0, { type: 'execution.started' }),
      ev(1, {
        type: 'plan.created',
        nodeKey: 'orch',
        planId: 'p1',
        subtasks: [
          { id: 's1', agentId: 'a1', task: 'x' },
          { id: 's2', agentId: 'a2', task: 'y' },
        ],
        edges: [{ source: 's1', target: 's2' }],
      }),
      ev(2, { type: 'subtask.started', nodeKey: 'orch', subtaskId: 's1', agentId: 'a1' }),
      ev(3, { type: 'subtask.succeeded', nodeKey: 'orch', subtaskId: 's1', output: 'ok1' }),
      ev(4, { type: 'results.merged', nodeKey: 'orch', summary: 'fusionado' }),
    ];
    const st = reduceExecution(events);
    expect(st.plan?.order).toEqual(['s1', 's2']);
    expect(st.plan?.subtasks.s1.status).toBe('succeeded');
    expect(st.plan?.subtasks.s1.output).toBe('ok1');
    expect(st.plan?.subtasks.s2.status).toBe('pending');
    expect(st.plan?.merged).toBe('fusionado');
  });
});
