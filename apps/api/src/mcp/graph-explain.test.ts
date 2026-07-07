import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@core/contracts';
import { explainGraph, staticFindings, structuralSignature } from './graph-explain';

const graph = (nodes: Array<[string, string]>, edges: Array<[string, string]>): WorkflowGraph => ({
  nodes: nodes.map(([key, type]) => ({ key, type: type as WorkflowGraph['nodes'][number]['type'], config: {}, position: { x: 0, y: 0 } })),
  edges: edges.map(([source, target]) => ({ source, target, sourceHandle: null })),
});

describe('graph-explain (M32)', () => {
  it('explainGraph describe niveles y emite mermaid', () => {
    const g = graph([['t', 'trigger'], ['a', 'agent'], ['e', 'end']], [['t', 'a'], ['a', 'e']]);
    const out = explainGraph(g);
    expect(out).toContain('3 nodos');
    expect(out).toContain('Nivel 1: t (trigger)');
    expect(out).toContain('```mermaid');
    expect(out).toContain('t --> a');
  });

  it('staticFindings detecta inalcanzables, callejones y falta de inicio/fin', () => {
    const g = graph([['a', 'agent'], ['b', 'tool']], []); // sin trigger ni end, sin aristas
    const f = staticFindings(g);
    expect(f.join(' ')).toMatch(/no hay nodo de inicio/i);
    expect(f.join(' ')).toMatch(/no hay nodo final/i);
    expect(f.join(' ')).toMatch(/inalcanzable/i);
    expect(f.join(' ')).toMatch(/callejón/i);
  });

  it('staticFindings no reporta nada en un flujo sano', () => {
    const g = graph([['t', 'trigger'], ['e', 'end']], [['t', 'e']]);
    expect(staticFindings(g)).toEqual(['Sin problemas estructurales detectados.']);
  });

  it('structuralSignature agrupa grafos con la misma forma', () => {
    const a = graph([['t', 'trigger'], ['e', 'end']], [['t', 'e']]);
    const b = graph([['x', 'trigger'], ['y', 'end']], [['x', 'y']]); // misma forma, distintos ids
    const c = graph([['t', 'trigger'], ['m', 'agent'], ['e', 'end']], [['t', 'm'], ['m', 'e']]);
    expect(structuralSignature(a)).toBe(structuralSignature(b));
    expect(structuralSignature(a)).not.toBe(structuralSignature(c));
  });
});
