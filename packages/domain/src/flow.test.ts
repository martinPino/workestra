import { describe, it, expect } from 'vitest';
import type { WorkflowEdge, ExecutionContext } from '@core/contracts';
import { edgeIsLive, shouldRunNode, flowDecisionOf } from './flow';

const edge = (source: string, target: string, sourceHandle: string | null = null): WorkflowEdge =>
  ({ source, target, sourceHandle }) as WorkflowEdge;

const ctx = (variables: Record<string, unknown>): ExecutionContext =>
  ({ variables, ticket: {}, repository: {} }) as unknown as ExecutionContext;

describe('flow (M14 · poda de ramas + skip)', () => {
  it('nodo normal (sin decisión): todas las aristas están vivas', () => {
    expect(edgeIsLive(edge('a', 'b'), undefined)).toBe(true);
  });

  it('router: solo las aristas cuyo target está en `targets` quedan vivas', () => {
    const d = { targets: ['b', 'd'] };
    expect(edgeIsLive(edge('r', 'b'), d)).toBe(true);
    expect(edgeIsLive(edge('r', 'c'), d)).toBe(false);
    expect(edgeIsLive(edge('r', 'd'), d)).toBe(true);
  });

  it('condición: solo la arista con el handle elegido queda viva (sin handle → fluye)', () => {
    const d = { handles: ['true'] };
    expect(edgeIsLive(edge('c', 'x', 'true'), d)).toBe(true);
    expect(edgeIsLive(edge('c', 'y', 'false'), d)).toBe(false);
    expect(edgeIsLive(edge('c', 'z', null), d)).toBe(true);
  });

  it('flowDecisionOf lee la decisión persistida en el contexto', () => {
    const c = ctx({ 'flow:r': { targets: ['b'] } });
    expect(flowDecisionOf(c, 'r')).toEqual({ targets: ['b'] });
    expect(flowDecisionOf(c, 'otro')).toBeUndefined();
  });

  it('shouldRunNode: nodo raíz (sin entrantes) siempre corre', () => {
    expect(shouldRunNode('t', [], new Set(), ctx({}))).toBe(true);
  });

  it('shouldRunNode: el router elige a «b», así «b» corre y «c» se salta', () => {
    const edges = [edge('r', 'b'), edge('r', 'c')];
    const completed = new Set(['r']);
    const c = ctx({ 'flow:r': { targets: ['b'] } });
    expect(shouldRunNode('b', edges, completed, c)).toBe(true);
    expect(shouldRunNode('c', edges, completed, c)).toBe(false);
  });

  it('shouldRunNode: fan-in con una entrante viva y otra muerta → corre', () => {
    const edges = [edge('r', 'fin'), edge('b', 'fin')];
    const completed = new Set(['r', 'b']);
    // el router r solo eligió a b (no a fin), pero b (nodo normal) sí activa su arista a fin
    const c = ctx({ 'flow:r': { targets: ['b'] } });
    expect(shouldRunNode('fin', edges, completed, c)).toBe(true);
  });

  it('shouldRunNode: predecesor NO completado (saltado) → arista muerta', () => {
    const edges = [edge('saltado', 'x')];
    // «saltado» no está en completed → su arista no puede estar viva
    expect(shouldRunNode('x', edges, new Set(), ctx({}))).toBe(false);
  });
});
