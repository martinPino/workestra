import type { WorkflowGraph } from '@core/contracts';

/**
 * Scheduler del DAG. Su contrato asume MÚLTIPLES nodos listos a la vez: `ready` devuelve el
 * CONJUNTO de nodos despachables (no "el siguiente"). En M1 el runner los despacha de forma
 * secuencial; en M4 solo cambia la POLÍTICA de despacho (paralelismo), no este contrato.
 */
export interface DagScheduler {
  readonly allNodeKeys: string[];
  /** Nodos aún no completados cuyos predecesores están TODOS en `completed`. Conjunto. */
  ready(completed: ReadonlySet<string>): string[];
  isComplete(completed: ReadonlySet<string>): boolean;
}

export function createScheduler(graph: WorkflowGraph): DagScheduler {
  const preds = new Map<string, Set<string>>();
  const all = new Set<string>();

  for (const n of graph.nodes) {
    preds.set(n.key, new Set());
    all.add(n.key);
  }
  for (const e of graph.edges) {
    if (all.has(e.source) && all.has(e.target) && e.source !== e.target) {
      preds.get(e.target)!.add(e.source);
    }
  }

  const allNodeKeys = [...all].sort();

  return {
    allNodeKeys,
    ready(completed) {
      const out: string[] = [];
      for (const key of allNodeKeys) {
        if (completed.has(key)) continue;
        const deps = preds.get(key)!;
        let ready = true;
        for (const dep of deps) {
          if (!completed.has(dep)) {
            ready = false;
            break;
          }
        }
        if (ready) out.push(key);
      }
      return out;
    },
    isComplete(completed) {
      return allNodeKeys.every((k) => completed.has(k));
    },
  };
}
