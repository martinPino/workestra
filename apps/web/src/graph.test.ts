import { describe, it, expect } from 'vitest';
import { WorkflowGraphSchema } from '@core/contracts';
import { docToWorkflowGraph, workflowGraphToDoc } from './graph';
import type { GraphDoc } from './editor/model';

const doc: GraphDoc = {
  nodes: [{ id: 'trigger', kind: 'trigger', position: { x: 0, y: 0 }, config: { event: 'manual' } }],
  edges: [],
  comments: [
    { id: 'c-1', text: 'Nueva nota\n- Un punto', position: { x: 12.4, y: 34.9 }, color: 'sky' },
    { id: 'c-2', text: 'Sin color', position: { x: 5, y: 5 } },
  ],
};

describe('notas del lienzo (M60): persistencia', () => {
  it('docToWorkflowGraph incluye las notas (con posición redondeada) y el color si lo hay', () => {
    const g = docToWorkflowGraph(doc);
    expect(g.comments).toEqual([
      { id: 'c-1', text: 'Nueva nota\n- Un punto', position: { x: 12, y: 35 }, color: 'sky' },
      { id: 'c-2', text: 'Sin color', position: { x: 5, y: 5 } },
    ]);
  });

  it('sobrevive al esquema Zod del contrato (no se descarta `comments`)', () => {
    const parsed = WorkflowGraphSchema.parse(docToWorkflowGraph(doc));
    expect(parsed.comments).toHaveLength(2);
    expect(parsed.comments?.[0].color).toBe('sky');
  });

  it('round-trip doc → grafo → doc conserva texto, posición y color', () => {
    const back = workflowGraphToDoc(WorkflowGraphSchema.parse(docToWorkflowGraph(doc)));
    expect(back.comments).toEqual([
      { id: 'c-1', text: 'Nueva nota\n- Un punto', position: { x: 12, y: 35 }, color: 'sky' },
      { id: 'c-2', text: 'Sin color', position: { x: 5, y: 5 }, color: undefined },
    ]);
  });

  it('grafo antiguo sin `comments` → doc con lista vacía (compatibilidad)', () => {
    const back = workflowGraphToDoc({ nodes: [], edges: [] });
    expect(back.comments).toEqual([]);
  });
});
