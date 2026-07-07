import { describe, it, expect } from 'vitest';
import type { WorkflowGraph, WorkflowNode } from '@core/contracts';
import { stripDisabledNodes, validateDag } from './index';

const n = (key: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  key,
  type: key === 'inicio' ? 'trigger' : key === 'fin' ? 'end' : 'tool',
  config: {},
  position: { x: 0, y: 0 },
  ...extra,
});
const e = (source: string, target: string, sourceHandle: string | null = null) => ({ source, target, sourceHandle });

describe('stripDisabledNodes (M38)', () => {
  it('devuelve el mismo grafo si no hay pasos desactivados', () => {
    const g: WorkflowGraph = { nodes: [n('inicio'), n('a'), n('fin')], edges: [e('inicio', 'a'), e('a', 'fin')] };
    expect(stripDisabledNodes(g)).toBe(g);
  });

  it('puentea un paso desactivado en el medio (inicio→A→fin ⇒ inicio→fin)', () => {
    const g: WorkflowGraph = {
      nodes: [n('inicio'), n('a', { disabled: true }), n('fin')],
      edges: [e('inicio', 'a'), e('a', 'fin')],
    };
    const out = stripDisabledNodes(g);
    expect(out.nodes.map((x) => x.key)).toEqual(['inicio', 'fin']);
    expect(out.edges).toEqual([{ source: 'inicio', target: 'fin', sourceHandle: null, condition: null }]);
    expect(validateDag(out).valid).toBe(true);
  });

  it('colapsa una cadena de varios pasos desactivados seguidos', () => {
    const g: WorkflowGraph = {
      nodes: [n('inicio'), n('a', { disabled: true }), n('b', { disabled: true }), n('fin')],
      edges: [e('inicio', 'a'), e('a', 'b'), e('b', 'fin')],
    };
    const out = stripDisabledNodes(g);
    expect(out.nodes.map((x) => x.key)).toEqual(['inicio', 'fin']);
    expect(out.edges).toEqual([{ source: 'inicio', target: 'fin', sourceHandle: null, condition: null }]);
  });

  it('conserva el sourceHandle de la rama al puentear (condición→[rama]→D→Y ⇒ condición→[rama]→Y)', () => {
    const g: WorkflowGraph = {
      nodes: [n('inicio'), n('cond', { type: 'condition' }), n('d', { disabled: true }), n('fin')],
      edges: [e('inicio', 'cond'), e('cond', 'd', 'true'), e('d', 'fin')],
    };
    const out = stripDisabledNodes(g);
    expect(out.edges).toContainEqual({ source: 'cond', target: 'fin', sourceHandle: 'true', condition: null });
  });

  it('con fan-out (D→Y y D→Z) crea un puente por cada salida', () => {
    const g: WorkflowGraph = {
      nodes: [n('inicio'), n('d', { disabled: true }), n('y'), n('z'), n('fin')],
      edges: [e('inicio', 'd'), e('d', 'y'), e('d', 'z'), e('y', 'fin'), e('z', 'fin')],
    };
    const out = stripDisabledNodes(g);
    expect(out.edges).toContainEqual({ source: 'inicio', target: 'y', sourceHandle: null, condition: null });
    expect(out.edges).toContainEqual({ source: 'inicio', target: 'z', sourceHandle: null, condition: null });
    expect(out.nodes.map((x) => x.key)).not.toContain('d');
  });
});
