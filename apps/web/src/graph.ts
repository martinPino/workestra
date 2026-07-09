import type { Node as RFNode, Edge as RFEdge } from 'reactflow';
import type { WorkflowGraph } from '@core/contracts';
import type { NodeRunStatus } from '@core/domain';
import type { GraphDoc, EditorNode } from './editor/model';

export interface AfNodeData {
  kind: EditorNode['kind'];
  status?: NodeRunStatus;
  /** M66: mensaje de error del paso (si `status === 'failed'`) → tooltip del sello ✗. */
  error?: string;
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
  color?: string;
  width?: number;
  height?: number;
}
/** Estado de animación de una arista (M65): la luz «viaja» cuando active; estela tenue cuando traversed. */
export interface FlowEdgeData {
  active?: boolean;
  traversed?: boolean;
}

/** GraphDoc -> nodos/aristas de React Flow (incluye comentarios como nodos tipo `comment`). */
export function docToReactFlow(
  doc: GraphDoc,
  nodeStatus: Record<string, NodeRunStatus>,
  editable = false,
  nodeErrors: Record<string, string> = {},
): { nodes: RFNode[]; edges: RFEdge[] } {
  const commentNodes: RFNode[] = doc.comments.map((c) => ({
    id: c.id,
    type: 'comment',
    position: c.position,
    data: { id: c.id, text: c.text, color: c.color, width: c.width, height: c.height } satisfies CommentNodeData,
    // Tamaño (M64): ancho por defecto 256 (alto automático) hasta que el usuario redimensione; NodeResizer
    // actualiza estas dimensiones y se persisten. `style` da al wrapper del nodo el tamaño que la nota llena.
    style: { width: c.width ?? 256, ...(c.height ? { height: c.height } : {}) },
    zIndex: 0,
  }));
  const graphNodes: RFNode[] = doc.nodes.map((n) => ({
    id: n.id,
    type: 'af',
    position: n.position,
    data: { kind: n.kind, status: nodeStatus[n.id], error: nodeErrors[n.id], config: n.config, disabled: n.disabled, editable } satisfies AfNodeData,
  }));
  const edges: RFEdge[] = doc.edges.map((e) => {
    // Estado en vivo de la arista (M65). La luz «viaja» SOLO hacia un destino que se está ejecutando
    // AHORA (running): así no se queda encendida tras un fallo (destino que nunca arrancó → ausente),
    // ni ilumina las ramas muertas de un router (aún sin arrancar) hasta que una se activa de verdad.
    // La estela tenue (traversed) marca el camino que el flujo YA recorrió: destino que corrió, falló
    // o está esperando aprobación. Un destino saltado o aún sin empezar deja la arista en reposo.
    const src = nodeStatus[e.source];
    const tgt = nodeStatus[e.target];
    const active = src === 'succeeded' && tgt === 'running';
    const traversed = src === 'succeeded' && (tgt === 'succeeded' || tgt === 'failed' || tgt === 'waiting');
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      type: 'animated',
      data: { active, traversed } satisfies FlowEdgeData,
    };
  });
  return { nodes: [...commentNodes, ...graphNodes], edges };
}

/** GraphDoc -> contrato WorkflowGraph (lo que persiste el backend). Las notas (M60) se persisten aparte. */
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
    // Notas del lienzo (M60): se guardan con el grafo para que sobrevivan a recargas.
    comments: doc.comments.map((c) => ({
      id: c.id,
      text: c.text,
      position: { x: Math.round(c.position.x), y: Math.round(c.position.y) },
      ...(c.color ? { color: c.color } : {}),
      ...(c.width ? { width: Math.round(c.width), height: Math.round(c.height ?? 0) || undefined } : {}),
    })),
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
    comments: (graph.comments ?? []).map((c) => ({
      id: c.id,
      text: c.text,
      position: c.position,
      color: c.color ?? undefined,
      width: c.width ?? undefined,
      height: c.height ?? undefined,
    })),
  };
}

export const STARTER_DOC: GraphDoc = {
  nodes: [
    { id: 'trigger', kind: 'trigger', position: { x: 40, y: 160 }, config: { event: 'manual' } },
    { id: 'work', kind: 'tool', position: { x: 300, y: 160 }, config: { message: 'Hola Workestra' } },
    { id: 'end', kind: 'end', position: { x: 560, y: 160 }, config: {} },
  ],
  edges: [
    { id: 'e_trigger_work', source: 'trigger', target: 'work' },
    { id: 'e_work_end', source: 'work', target: 'end' },
  ],
  comments: [],
};
