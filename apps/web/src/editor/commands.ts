import type { GraphDoc, EditorNode, EditorEdge, EditorComment } from './model';

/**
 * Comando del editor con inversa exacta: se cumple `undo(redo(doc)) ≡ doc` (property test).
 * Cada factory captura del `doc` actual los datos necesarios para invertir (config previa,
 * nodos/aristas eliminados, etc.), de modo que la inversa es determinista.
 */
export interface Command {
  readonly label: string;
  redo(doc: GraphDoc): GraphDoc;
  undo(doc: GraphDoc): GraphDoc;
}

export function addNode(node: EditorNode): Command {
  return {
    label: 'Añadir nodo',
    redo: (d) => ({ ...d, nodes: [...d.nodes, node] }),
    undo: (d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== node.id) }),
  };
}

/**
 * Reemplaza TODO el grafo (nodos + aristas) — p. ej. una reescritura del chat de IA (M30). Conserva los
 * comentarios/notas (spread `...d`) y es REVERSIBLE con ⌘Z (guarda el grafo previo para invertir), en vez de
 * `loadDoc` que borra las notas y resetea el historial.
 */
export function replaceGraph(doc: GraphDoc, nodes: EditorNode[], edges: EditorEdge[]): Command {
  const prevNodes = doc.nodes;
  const prevEdges = doc.edges;
  return {
    label: 'Rehacer flujo con IA',
    redo: (d) => ({ ...d, nodes, edges }),
    undo: (d) => ({ ...d, nodes: prevNodes, edges: prevEdges }),
  };
}

export function removeNodes(doc: GraphDoc, ids: string[]): Command {
  const set = new Set(ids);
  const nodes = doc.nodes.filter((n) => set.has(n.id));
  const edges = doc.edges.filter((e) => set.has(e.source) || set.has(e.target));
  return {
    label: 'Eliminar nodos',
    redo: (d) => ({
      ...d,
      nodes: d.nodes.filter((n) => !set.has(n.id)),
      edges: d.edges.filter((e) => !set.has(e.source) && !set.has(e.target)),
    }),
    undo: (d) => ({ ...d, nodes: [...d.nodes, ...nodes], edges: [...d.edges, ...edges] }),
  };
}

export interface Move {
  id: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export function moveNodes(moves: Move[]): Command {
  const map = new Map(moves.map((m) => [m.id, m]));
  return {
    label: 'Mover nodos',
    redo: (d) => ({ ...d, nodes: d.nodes.map((n) => (map.has(n.id) ? { ...n, position: map.get(n.id)!.to } : n)) }),
    undo: (d) => ({ ...d, nodes: d.nodes.map((n) => (map.has(n.id) ? { ...n, position: map.get(n.id)!.from } : n)) }),
  };
}

export function addEdge(edge: EditorEdge): Command {
  return {
    label: 'Conectar',
    redo: (d) => ({ ...d, edges: [...d.edges, edge] }),
    undo: (d) => ({ ...d, edges: d.edges.filter((e) => e.id !== edge.id) }),
  };
}

export function removeEdges(doc: GraphDoc, ids: string[]): Command {
  const set = new Set(ids);
  const edges = doc.edges.filter((e) => set.has(e.id));
  return {
    label: 'Eliminar aristas',
    redo: (d) => ({ ...d, edges: d.edges.filter((e) => !set.has(e.id)) }),
    undo: (d) => ({ ...d, edges: [...d.edges, ...edges] }),
  };
}

export function updateNodeConfig(doc: GraphDoc, id: string, config: Record<string, unknown>): Command {
  const prev = doc.nodes.find((n) => n.id === id)?.config ?? {};
  return {
    label: 'Editar propiedades',
    redo: (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, config } : n)) }),
    undo: (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, config: prev } : n)) }),
  };
}

/** M38: activa/desactiva un paso. La inversa restaura el estado previo (undo/redo exacto). */
export function setNodeDisabled(doc: GraphDoc, id: string, disabled: boolean): Command {
  const prev = doc.nodes.find((n) => n.id === id)?.disabled ?? false;
  return {
    label: disabled ? 'Desactivar paso' : 'Activar paso',
    redo: (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, disabled } : n)) }),
    undo: (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, disabled: prev } : n)) }),
  };
}

export function pasteFragment(nodes: EditorNode[], edges: EditorEdge[]): Command {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeIds = new Set(edges.map((e) => e.id));
  return {
    label: 'Pegar',
    redo: (d) => ({ ...d, nodes: [...d.nodes, ...nodes], edges: [...d.edges, ...edges] }),
    undo: (d) => ({
      ...d,
      nodes: d.nodes.filter((n) => !nodeIds.has(n.id)),
      edges: d.edges.filter((e) => !edgeIds.has(e.id)),
    }),
  };
}

export function addComment(comment: EditorComment): Command {
  return {
    label: 'Añadir comentario',
    redo: (d) => ({ ...d, comments: [...d.comments, comment] }),
    undo: (d) => ({ ...d, comments: d.comments.filter((c) => c.id !== comment.id) }),
  };
}

export function updateComment(doc: GraphDoc, id: string, text: string): Command {
  const prev = doc.comments.find((c) => c.id === id)?.text ?? '';
  return {
    label: 'Editar comentario',
    redo: (d) => ({ ...d, comments: d.comments.map((c) => (c.id === id ? { ...c, text } : c)) }),
    undo: (d) => ({ ...d, comments: d.comments.map((c) => (c.id === id ? { ...c, text: prev } : c)) }),
  };
}

export function removeComment(doc: GraphDoc, id: string): Command {
  const comment = doc.comments.find((c) => c.id === id);
  return {
    label: 'Eliminar comentario',
    redo: (d) => ({ ...d, comments: d.comments.filter((c) => c.id !== id) }),
    undo: (d) => ({ ...d, comments: comment ? [...d.comments, comment] : d.comments }),
  };
}
