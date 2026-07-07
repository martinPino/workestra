import type { Node as RFNode, Edge as RFEdge } from 'reactflow';
import type { WorkflowGraph } from '@core/contracts';
import type { NodeRunStatus } from '@core/domain';
import type { GraphDoc, EditorNode } from './editor/model';

export interface AfNodeData {
  kind: EditorNode['kind'];
  status?: NodeRunStatus;
  /** Config del nodo: la carta la usa para resolver identidad (p. ej. el agente elegido). */
  config?: Record<string, unknown>;
  /** M38: paso desactivado (se pinta atenuado; el motor lo salta). */
  disabled?: boolean;
  /** M38: true solo en el editor → muestra la barra flotante de controles al hover (no en solo-lectura). */
  editable?: boolean;
}
export interface CommentNodeData {
  id: string;
  text: string;
}

/** GraphDoc -> nodos/aristas de React Flow (incluye comentarios como nodos tipo `comment`). */
export function docToReactFlow(
  doc: GraphDoc,
  nodeStatus: Record<string, NodeRunStatus>,
  editable = false,
): { nodes: RFNode[]; edges: RFEdge[] } {
  const commentNodes: RFNode[] = doc.comments.map((c) => ({
    id: c.id,
    type: 'comment',
    position: c.position,
    data: { id: c.id, text: c.text } satisfies CommentNodeData,
    zIndex: 0,
  }));
  const graphNodes: RFNode[] = doc.nodes.map((n) => ({
    id: n.id,
    type: 'af',
    position: n.position,
    data: { kind: n.kind, status: nodeStatus[n.id], config: n.config, disabled: n.disabled, editable } satisfies AfNodeData,
  }));
  const edges: RFEdge[] = doc.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    animated: true,
  }));
  return { nodes: [...commentNodes, ...graphNodes], edges };
}

/** GraphDoc -> contrato WorkflowGraph (lo que persiste el backend). Los comentarios son locales. */
export function docToWorkflowGraph(doc: GraphDoc): WorkflowGraph {
  return {
    nodes: doc.nodes.map((n) => ({
      key: n.id,
      type: n.kind,
      config: n.config,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      ...(n.disabled ? { disabled: true } : {}), // M38: solo se persiste cuando está desactivado
    })),
    edges: doc.edges.map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  };
}

/** Contrato WorkflowGraph -> GraphDoc del editor. */
export function workflowGraphToDoc(graph: WorkflowGraph): GraphDoc {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.key,
      kind: n.type,
      position: n.position,
      config: (n.config as Record<string, unknown>) ?? {},
      ...(n.disabled ? { disabled: true } : {}), // M38
    })),
    edges: graph.edges.map((e, i) => ({
      id: `e_${e.source}_${e.target}_${i}`,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
    })),
    comments: [],
  };
}

export const STARTER_DOC: GraphDoc = {
  nodes: [
    { id: 'trigger', kind: 'trigger', position: { x: 40, y: 160 }, config: { event: 'manual' } },
    { id: 'work', kind: 'tool', position: { x: 300, y: 160 }, config: { message: 'Hola AgentFlow' } },
    { id: 'end', kind: 'end', position: { x: 560, y: 160 }, config: {} },
  ],
  edges: [
    { id: 'e_trigger_work', source: 'trigger', target: 'work' },
    { id: 'e_work_end', source: 'work', target: 'end' },
  ],
  comments: [],
};
