import type { WorkflowGraph } from '@core/contracts';

export type TriggerEvent = 'manual' | 'webhook' | 'cron';

/**
 * Evento configurado en el nodo Trigger del grafo (el primero de tipo `trigger`). Gobierna qué
 * integración puede crearse para el workflow: `webhook` ⇒ webhooks entrantes, `cron` ⇒ triggers
 * programados, `manual` ⇒ solo ejecución manual (ninguna integración). Si no hay nodo trigger o el
 * valor es desconocido, se asume `manual` (lo más restrictivo).
 */
export function triggerEventOf(graph: WorkflowGraph | undefined | null): TriggerEvent {
  const trigger = graph?.nodes.find((n) => n.type === 'trigger');
  const ev = trigger?.config?.event;
  return ev === 'webhook' || ev === 'cron' ? ev : 'manual';
}
