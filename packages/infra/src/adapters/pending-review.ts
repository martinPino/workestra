import type { IPendingReviewRepository, PendingReviewRecord } from '@core/engine';

/**
 * Repositorio in-memory de revisiones humanas (M5). La identidad es DETERMINISTA por
 * (executionId, nodeKey), lo que da idempotencia natural: el nodo Humano re-ejecutado tras reanudar
 * recupera exactamente la misma revisión en vez de crear otra. La resolución solo transiciona una
 * vez (aprobar/rechazar sobre una revisión ya resuelta devuelve el estado actual sin efectos).
 */
export class InMemoryPendingReviewRepository implements IPendingReviewRepository {
  private readonly byId = new Map<string, PendingReviewRecord>();
  private seq = 0;

  private key(executionId: string, nodeKey: string): string {
    return `${executionId}::${nodeKey}`;
  }

  async findByNode(executionId: string, nodeKey: string): Promise<PendingReviewRecord | null> {
    return this.byId.get(this.key(executionId, nodeKey)) ?? null;
  }

  async create(input: { executionId: string; nodeKey: string; reason: string; expiresAt?: string | null }): Promise<PendingReviewRecord> {
    const id = this.key(input.executionId, input.nodeKey);
    const existing = this.byId.get(id);
    if (existing) return existing; // idempotente
    const record: PendingReviewRecord = {
      id,
      executionId: input.executionId,
      nodeKey: input.nodeKey,
      status: 'pending',
      reason: input.reason,
      decision: null,
      resolvedBy: null,
      createdAt: new Date(Date.now() + this.seq++).toISOString(),
      expiresAt: input.expiresAt ?? null,
    };
    this.byId.set(id, record);
    return record;
  }

  async get(id: string): Promise<PendingReviewRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listByExecution(executionId: string): Promise<PendingReviewRecord[]> {
    return [...this.byId.values()].filter((r) => r.executionId === executionId);
  }

  async resolve(
    id: string,
    decision: { approved: boolean; resolvedBy: string; decision: string },
  ): Promise<{ record: PendingReviewRecord; transitioned: boolean }> {
    const record = this.byId.get(id);
    if (!record) throw new Error(`Revisión no encontrada: ${id}`);
    if (record.status !== 'pending') return { record, transitioned: false }; // idempotente: carrera perdida
    const updated: PendingReviewRecord = {
      ...record,
      status: decision.approved ? 'approved' : 'rejected',
      decision: decision.decision,
      resolvedBy: decision.resolvedBy,
    };
    this.byId.set(id, updated);
    return { record: updated, transitioned: true };
  }
}
