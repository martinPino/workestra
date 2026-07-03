import type { WorkflowGraph } from '@core/contracts';
import { topologicalLevels } from './dag';

export interface ExecutionPlan {
  /** Niveles topológicos; los nodos de un mismo nivel son paralelizables. */
  levels: string[][];
  /** Orden topológico lineal (aplanado). */
  order: string[];
}

/**
 * Construye el plan de ejecución a partir del grafo. Lanza si el grafo no es un DAG
 * (usar `validateDag` antes para obtener errores detallados).
 */
export function buildExecutionPlan(graph: WorkflowGraph): ExecutionPlan {
  const levels = topologicalLevels(graph);
  if (levels === null) {
    throw new Error('No se puede construir el plan de ejecución: el grafo no es un DAG.');
  }
  return { levels, order: levels.flat() };
}
