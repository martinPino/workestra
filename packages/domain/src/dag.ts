import type { WorkflowGraph } from '@core/contracts';

export interface DagValidationError {
  code:
    | 'DUPLICATE_NODE_KEY'
    | 'EDGE_SOURCE_MISSING'
    | 'EDGE_TARGET_MISSING'
    | 'SELF_LOOP'
    | 'CYCLE';
  message: string;
  nodeKey?: string;
}

export interface DagValidationResult {
  valid: boolean;
  errors: DagValidationError[];
}

/**
 * Valida que el grafo sea un DAG bien formado: claves únicas, aristas sin colgar,
 * sin auto-lazos y sin ciclos. Función pura.
 */
export function validateDag(graph: WorkflowGraph): DagValidationResult {
  const errors: DagValidationError[] = [];
  const keys = new Set<string>();

  for (const n of graph.nodes) {
    if (keys.has(n.key)) {
      errors.push({ code: 'DUPLICATE_NODE_KEY', message: `Clave de nodo duplicada: ${n.key}`, nodeKey: n.key });
    }
    keys.add(n.key);
  }

  for (const e of graph.edges) {
    if (!keys.has(e.source)) {
      errors.push({ code: 'EDGE_SOURCE_MISSING', message: `Arista con origen inexistente: ${e.source}`, nodeKey: e.source });
    }
    if (!keys.has(e.target)) {
      errors.push({ code: 'EDGE_TARGET_MISSING', message: `Arista con destino inexistente: ${e.target}`, nodeKey: e.target });
    }
    if (e.source === e.target) {
      errors.push({ code: 'SELF_LOOP', message: `Auto-lazo en nodo: ${e.source}`, nodeKey: e.source });
    }
  }

  if (errors.length === 0 && topologicalLevels(graph) === null) {
    errors.push({ code: 'CYCLE', message: 'El grafo contiene un ciclo (no es un DAG).' });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Niveles topológicos (algoritmo de Kahn). Los nodos de un mismo nivel no dependen
 * entre sí y pueden ejecutarse en paralelo. Devuelve `null` si hay ciclo.
 */
export function topologicalLevels(graph: WorkflowGraph): string[][] | null {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const n of graph.nodes) {
    indeg.set(n.key, 0);
    adj.set(n.key, []);
  }
  for (const e of graph.edges) {
    if (!indeg.has(e.source) || !indeg.has(e.target) || e.source === e.target) continue;
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }

  const levels: string[][] = [];
  let frontier = graph.nodes.filter((n) => (indeg.get(n.key) ?? 0) === 0).map((n) => n.key);
  let visited = 0;

  while (frontier.length > 0) {
    levels.push([...frontier].sort());
    const next: string[] = [];
    for (const key of frontier) {
      visited++;
      for (const m of adj.get(key) ?? []) {
        const d = (indeg.get(m) ?? 0) - 1;
        indeg.set(m, d);
        if (d === 0) next.push(m);
      }
    }
    frontier = next;
  }

  return visited === graph.nodes.length ? levels : null;
}

export function hasCycle(graph: WorkflowGraph): boolean {
  return topologicalLevels(graph) === null;
}
