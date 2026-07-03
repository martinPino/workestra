import { describe, it, expect } from 'vitest';
import type { WorkflowGraph, WorkflowNode } from '@core/contracts';
import { createScheduler } from './scheduler';

const node = (key: string): WorkflowNode => ({ key, type: 'tool', config: {}, position: { x: 0, y: 0 } });

describe('DagScheduler — contrato "nodos listos como conjunto"', () => {
  it('expone MÚLTIPLES nodos listos a la vez (no siguiente-único)', () => {
    // a -> b, a -> c  => tras completar a, {b, c} están listos simultáneamente
    const g: WorkflowGraph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
      ],
    };
    const s = createScheduler(g);

    expect(s.ready(new Set())).toEqual(['a']);
    const afterA = s.ready(new Set(['a']));
    expect(afterA).toHaveLength(2);
    expect(new Set(afterA)).toEqual(new Set(['b', 'c']));
  });

  it('un nodo no está listo hasta que TODOS sus predecesores están completos (fan-in)', () => {
    // b -> d, c -> d
    const g: WorkflowGraph = {
      nodes: [node('b'), node('c'), node('d')],
      edges: [
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
      ],
    };
    const s = createScheduler(g);
    expect(s.ready(new Set(['b']))).not.toContain('d');
    expect(s.ready(new Set(['b', 'c']))).toContain('d');
  });

  it('isComplete cuando todos los nodos están completados', () => {
    const g: WorkflowGraph = { nodes: [node('a'), node('b')], edges: [{ source: 'a', target: 'b' }] };
    const s = createScheduler(g);
    expect(s.isComplete(new Set(['a']))).toBe(false);
    expect(s.isComplete(new Set(['a', 'b']))).toBe(true);
  });
});
