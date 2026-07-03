import type { EditorEdge } from './model';

/**
 * DAG guard: ¿añadir la arista source→target crearía un ciclo? Ocurre si `target` ya alcanza
 * a `source`. Búsqueda en profundidad desde target sobre las aristas existentes.
 */
export function wouldCreateCycle(
  edges: Pick<EditorEdge, 'source' | 'target'>[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true;

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source);
    if (list) list.push(e.target);
    else adj.set(e.source, [e.target]);
  }

  const stack = [target];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === source) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    const next = adj.get(node);
    if (next) for (const m of next) stack.push(m);
  }
  return false;
}

/**
 * Índice de ciclos reutilizable: mantiene la lista de aristas y responde consultas de "¿crearía
 * ciclo?" en O(V+E). Para grafos grandes (500+ nodos) se mantiene dentro del presupuesto.
 */
export class CycleIndex {
  constructor(private edges: Pick<EditorEdge, 'source' | 'target'>[] = []) {}

  setEdges(edges: Pick<EditorEdge, 'source' | 'target'>[]): void {
    this.edges = edges;
  }

  wouldCreateCycle(source: string, target: string): boolean {
    return wouldCreateCycle(this.edges, source, target);
  }
}
