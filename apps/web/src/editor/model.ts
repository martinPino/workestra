import type { NodeType } from '@core/contracts';

/** Documento del editor: fuente de verdad pura sobre la que operan los comandos. */
export interface EditorNode {
  id: string;
  kind: NodeType;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  /** M38: paso desactivado — se ve atenuado y el motor lo salta al ejecutar. */
  disabled?: boolean;
}

export interface EditorEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

export interface EditorComment {
  id: string;
  text: string;
  position: { x: number; y: number };
  /** Color de la nota (M60): clave de NOTE_COLORS (amber por defecto). */
  color?: string;
  /** Tamaño de la nota (M64): redimensionable arrastrando la esquina. */
  width?: number;
  height?: number;
}

export interface GraphDoc {
  nodes: EditorNode[];
  edges: EditorEdge[];
  comments: EditorComment[];
}

export const emptyDoc = (): GraphDoc => ({ nodes: [], edges: [], comments: [] });

/** Normaliza (ordena por id) para comparar documentos sin depender del orden de arrays. */
export function normalizeDoc(doc: GraphDoc): GraphDoc {
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    nodes: [...doc.nodes].sort(byId),
    edges: [...doc.edges].sort(byId),
    comments: [...doc.comments].sort(byId),
  };
}
