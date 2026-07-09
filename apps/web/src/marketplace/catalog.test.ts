import { describe, it, expect } from 'vitest';
import { validateDag } from '@core/domain';
import { MARKETPLACE } from './catalog';
import { docToWorkflowGraph } from '../graph';

/**
 * El instalador (install.ts) convierte el grafo de la receta con `docToWorkflowGraph` y crea el workflow,
 * que el backend RECHAZA si no es un DAG. Estos tests validan el catálogo en el front para que un item mal
 * cableado (arista colgando, ciclo, agentRef sin sembrar) no llegue a producción como «instalar → error».
 */
describe('catálogo del Marketplace', () => {
  const withWorkflow = MARKETPLACE.filter((i) => i.install.workflow);

  it('hay items con workflow que validar', () => {
    expect(withWorkflow.length).toBeGreaterThan(0);
  });

  for (const item of withWorkflow) {
    const wf = item.install.workflow!;

    it(`«${item.name}» instala un grafo DAG válido con inicio y fin`, () => {
      const graph = docToWorkflowGraph(wf.doc);
      const res = validateDag(graph);
      expect(res.errors).toEqual([]);
      expect(graph.nodes.some((n) => n.type === 'trigger')).toBe(true);
      expect(graph.nodes.some((n) => n.type === 'end')).toBe(true);
    });

    it(`«${item.name}»: cada agentRef del grafo tiene su agente en la receta`, () => {
      const seeded = new Set((item.install.agents ?? []).map((a) => a.ref));
      const used = wf.doc.nodes
        .map((n) => (n.config as Record<string, unknown>)?.agentRef)
        .filter((r): r is string => typeof r === 'string');
      for (const ref of used) expect(seeded.has(ref)).toBe(true);
    });
  }
});
