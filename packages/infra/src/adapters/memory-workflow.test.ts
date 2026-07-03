import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@core/contracts';
import { InMemoryWorkflowRepository } from './memory-workflow';

const graph = (label: string): WorkflowGraph => ({
  nodes: [{ key: 'n', type: 'tool', config: { label }, position: { x: 0, y: 0 } }],
  edges: [],
});
const labelOf = (g: WorkflowGraph) => (g.nodes[0].config as { label: string }).label;

describe('InMemoryWorkflowRepository — versionado y pin (M4p)', () => {
  it('draft/publish crea versiones inmutables; editar+publicar no altera versiones previas', async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf = await repo.create({ workspaceId: 'ws', name: 'W', graph: graph('v1-draft') });

    const v1 = await repo.publish(wf.id);
    expect(v1.version).toBe(1);
    expect(v1.state).toBe('published');

    await repo.saveGraph(wf.id, graph('v2-draft')); // editar el draft
    const v2 = await repo.publish(wf.id);
    expect(v2.version).toBe(2);

    // v1 permanece INMUTABLE (pin): su snapshot no cambia al editar/publicar después.
    expect(labelOf((await repo.getVersion(v1.id))!.graph)).toBe('v1-draft');
    expect(labelOf((await repo.getVersion(v2.id))!.graph)).toBe('v2-draft');

    // resolveRunVersion devuelve la última published (v2).
    expect((await repo.resolveRunVersion(wf.id)).id).toBe(v2.id);
  });

  it('resolveRunVersion auto-publica el draft si no hay versión activa', async () => {
    const repo = new InMemoryWorkflowRepository();
    const wf = await repo.create({ workspaceId: 'ws', name: 'W', graph: graph('draft-only') });
    const run = await repo.resolveRunVersion(wf.id);
    expect(run.state).toBe('published');
    expect(run.version).toBe(1);
  });
});
