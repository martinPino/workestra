import { describe, it, expect } from 'vitest';
import type { WorkflowGraph, WorkflowNode } from '@core/contracts';
import { validateDag, hasCycle, buildExecutionPlan } from './index';

const node = (key: string): WorkflowNode => ({
  key,
  type: 'tool',
  config: {},
  position: { x: 0, y: 0 },
});

describe('validateDag', () => {
  it('acepta un DAG lineal válido', () => {
    const g: WorkflowGraph = {
      nodes: [node('a'), node('b')],
      edges: [{ source: 'a', target: 'b' }],
    };
    expect(validateDag(g).valid).toBe(true);
  });

  it('detecta un ciclo', () => {
    const g: WorkflowGraph = {
      nodes: [node('a'), node('b')],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    };
    const r = validateDag(g);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'CYCLE')).toBe(true);
    expect(hasCycle(g)).toBe(true);
  });

  it('detecta aristas colgantes', () => {
    const g: WorkflowGraph = { nodes: [node('a')], edges: [{ source: 'a', target: 'z' }] };
    const r = validateDag(g);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.code === 'EDGE_TARGET_MISSING')).toBe(true);
  });

  it('detecta claves de nodo duplicadas', () => {
    const g: WorkflowGraph = { nodes: [node('a'), node('a')], edges: [] };
    expect(validateDag(g).valid).toBe(false);
  });
});

describe('buildExecutionPlan', () => {
  it('agrupa nodos paralelos en el mismo nivel topológico', () => {
    const g: WorkflowGraph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
      ],
    };
    const plan = buildExecutionPlan(g);
    expect(plan.levels[0]).toEqual(['a']);
    expect(plan.levels[1]).toEqual(['b', 'c']);
    expect(plan.order).toEqual(['a', 'b', 'c']);
  });

  it('lanza si el grafo no es un DAG', () => {
    const g: WorkflowGraph = {
      nodes: [node('a'), node('b')],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    };
    expect(() => buildExecutionPlan(g)).toThrow();
  });
});
