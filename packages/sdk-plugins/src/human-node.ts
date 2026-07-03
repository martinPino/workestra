import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType } from '@core/contracts';
import type { IPendingReviewRepository } from '@core/engine';

/**
 * Nodo Humano (human-in-the-loop, M5). Primera ejecución: crea una revisión `pending` y devuelve
 * `pause` — el runner suspende la ejecución en `WAITING_HUMAN`. Al reanudar (tras aprobar), el nodo
 * RE-EJECUTA y lee el estado de la revisión: aprobado → `continue` (anota la decisión en el
 * contexto); rechazado → `end`; aún pendiente → `pause` de nuevo. La re-entrada es idempotente
 * porque la revisión es única por (executionId, nodeKey).
 */
export class HumanNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'human';

  constructor(private readonly reviews: IPendingReviewRepository) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const config = ctx.config as { reason?: string; ttlMs?: number };
    const reason = String(config.reason ?? 'Aprobación humana requerida');

    const existing = await this.reviews.findByNode(ctx.executionId, ctx.nodeKey);

    if (!existing) {
      const ttlMs = Number(config.ttlMs ?? 0);
      const expiresAt = ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : null;
      const review = await this.reviews.create({ executionId: ctx.executionId, nodeKey: ctx.nodeKey, reason, expiresAt });
      ctx.emit({ type: 'human.requested', nodeKey: ctx.nodeKey, reviewId: review.id, reason, expiresAt: expiresAt ?? '' });
      return { context: ctx.context, control: { kind: 'pause', reason } };
    }

    if (existing.status === 'pending') {
      // Reanudado pero sin resolución todavía: re-pausa (defensivo/idempotente).
      return { context: ctx.context, control: { kind: 'pause', reason } };
    }

    if (existing.status === 'approved') {
      const variables = {
        ...ctx.context.variables,
        [`human:${ctx.nodeKey}`]: { approved: true, decision: existing.decision, resolvedBy: existing.resolvedBy },
      };
      return { context: { ...ctx.context, variables }, control: { kind: 'continue' } };
    }

    // Rechazado: la ejecución debe FALLAR, no terminar con éxito. Lanzar → execution.failed → FAILED
    // (coherente con el reducer: human.resolved{approved:false} => FAILED). Si un resume ocurriera
    // tras un rechazo (p. ej. por un fallo previo al marcar FAILED), esto lo corrige de forma segura.
    throw new Error(`Revisión humana rechazada${existing.decision ? `: ${existing.decision}` : ''}`);
  }
}
