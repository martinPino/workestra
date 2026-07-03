import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import type { PendingReviewRecord } from '@core/engine';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { ExecutionsService } from './executions.service';
import { ExecutionEventHub } from './execution-event-hub';

export interface ResolveReviewInput {
  approved: boolean;
  resolvedBy: string;
  decision?: string;
  reviewId?: string;
}

export interface ResolveReviewResult {
  review: PendingReviewRecord;
  alreadyResolved: boolean;
}

/**
 * Servicio de escalado humano (M5). Resuelve una revisión pendiente y decide el destino de la
 * ejecución suspendida: aprobar → REANUDA (el nodo Humano re-ejecuta y continúa); rechazar → marca
 * la ejecución FAILED. Es IDEMPOTENTE: resolver una revisión ya resuelta no reanuda ni re-emite.
 * Una revisión EXPIRADA solo puede resolverse como rechazo (decisión `expired`).
 */
@Injectable()
export class HumanEscalationService {
  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    private readonly executions: ExecutionsService,
    private readonly hub: ExecutionEventHub,
  ) {}

  async listReviews(executionId: string, workspaceId: string): Promise<PendingReviewRecord[]> {
    await this.executions.assertOwned(executionId, workspaceId); // solo revisiones del propio tenant
    return this.p.pendingReviews.listByExecution(executionId);
  }

  async resolveReview(executionId: string, workspaceId: string, input: ResolveReviewInput): Promise<ResolveReviewResult> {
    await this.executions.assertOwned(executionId, workspaceId); // la ejecución debe ser del tenant
    const review = input.reviewId
      ? await this.p.pendingReviews.get(input.reviewId)
      : (await this.p.pendingReviews.listByExecution(executionId)).find((r) => r.status === 'pending') ?? null;

    if (!review) throw new NotFoundException('No hay revisión pendiente para esta ejecución.');
    if (review.executionId !== executionId) {
      throw new BadRequestException('La revisión no pertenece a la ejecución indicada.');
    }
    if (review.status !== 'pending') {
      return { review, alreadyResolved: true }; // idempotente: ya resuelta
    }

    const expired = review.expiresAt ? Date.parse(review.expiresAt) < Date.now() : false;
    const approved = expired ? false : input.approved;
    const decision = expired ? 'expired' : input.decision ?? (approved ? 'approved' : 'rejected');

    // Transición atómica. Si `transitioned` es false, otra petición concurrente ya la resolvió: NO
    // re-emitimos eventos ni reanudamos (idempotencia bajo concurrencia).
    const { record: resolved, transitioned } = await this.p.pendingReviews.resolve(review.id, {
      approved,
      resolvedBy: input.resolvedBy,
      decision,
    });
    if (!transitioned) return { review: resolved, alreadyResolved: true };

    await this.hub.emit(executionId, {
      type: 'human.resolved',
      nodeKey: review.nodeKey,
      reviewId: review.id,
      approved,
      resolvedBy: input.resolvedBy,
      decision,
    });

    if (approved) {
      await this.executions.resume(executionId, review.id);
    } else {
      await this.p.executions.updateStatus(executionId, 'FAILED');
      await this.hub.emit(executionId, { type: 'execution.failed', error: `Revisión humana rechazada (${decision}).` });
    }

    return { review: resolved, alreadyResolved: false };
  }
}
