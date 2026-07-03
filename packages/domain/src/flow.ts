import type { WorkflowEdge, ExecutionContext } from '@core/contracts';

/**
 * Control de flujo condicional (M14). Un nodo fuente puede PODAR sus aristas salientes: sólo algunas
 * quedan ACTIVAS y las demás mueren, saltando a sus nodos destino. La decisión se PERSISTE en el
 * contexto bajo `flow:<nodeKey>` (resume-safe: se reconstruye del checkpoint, no de un control
 * transitorio). Así el mismo mecanismo sirve al nodo Condición (por `handles`) y al Router (por
 * `targets`), y termina el pruning de ramas que quedó pendiente.
 */
export interface FlowDecision {
  /** Handles de salida activos (nodo Condición: `['true']` o `['false']`). */
  handles?: string[];
  /** Claves de nodo destino activas (nodo Router: elige a qué agentes/nodos enruta). */
  targets?: string[];
}

/** Lee la decisión de flujo de un nodo fuente desde el contexto (undefined = nodo normal → todo activo). */
export function flowDecisionOf(ctx: ExecutionContext, sourceKey: string): FlowDecision | undefined {
  const v = (ctx.variables as Record<string, unknown>)?.[`flow:${sourceKey}`];
  return v && typeof v === 'object' ? (v as FlowDecision) : undefined;
}

/** ¿La arista está VIVA? Nodo normal (sin decisión) → viva. Con decisión: por `targets` (router) o
 *  por `handles` (condición; una arista sin handle fluye siempre). */
export function edgeIsLive(edge: WorkflowEdge, decision: FlowDecision | undefined): boolean {
  if (!decision) return true;
  if (decision.targets) return decision.targets.includes(edge.target);
  if (decision.handles) return edge.sourceHandle == null || decision.handles.includes(edge.sourceHandle);
  return true;
}

/**
 * Decide si un nodo (cuyos predecesores están TODOS resueltos: completados o saltados) debe
 * EJECUTARSE o SALTARSE. Un nodo raíz (sin entrantes) siempre corre. Si no, corre sólo si tiene al
 * menos una arista entrante VIVA (fuente COMPLETADA y arista activa). Si todas están muertas (fuentes
 * saltadas o aristas podadas) → se salta. Esto propaga el skip transitivamente aguas abajo.
 */
export function shouldRunNode(
  nodeKey: string,
  edges: readonly WorkflowEdge[],
  completed: ReadonlySet<string>,
  ctx: ExecutionContext,
): boolean {
  const incoming = edges.filter((e) => e.target === nodeKey && e.source !== nodeKey);
  if (incoming.length === 0) return true;
  return incoming.some((e) => completed.has(e.source) && edgeIsLive(e, flowDecisionOf(ctx, e.source)));
}
