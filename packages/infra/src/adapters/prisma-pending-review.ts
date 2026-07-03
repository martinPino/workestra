import type { PrismaClient } from '@prisma/client';
import type { IPendingReviewRepository, PendingReviewRecord, PendingReviewStatus } from '@core/engine';

/**
 * Adaptador Prisma del puerto IPendingReviewRepository (M5-B, durable). `create` usa `upsert` sobre
 * la unique (executionId, nodeKey) → idempotente aunque el nodo Humano re-ejecute. `resolve` usa
 * `updateMany` filtrando por `status: 'pending'` → solo transiciona UNA vez (idempotente y sin
 * carrera): resolver una revisión ya resuelta no la modifica.
 */
export class PrismaPendingReviewRepository implements IPendingReviewRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByNode(executionId: string, nodeKey: string): Promise<PendingReviewRecord | null> {
    const row = await this.prisma.pendingReview.findUnique({
      where: { executionId_nodeKey: { executionId, nodeKey } },
    });
    return row ? this.toDomain(row) : null;
  }

  async create(input: { executionId: string; nodeKey: string; reason: string; expiresAt?: string | null }): Promise<PendingReviewRecord> {
    const row = await this.prisma.pendingReview.upsert({
      where: { executionId_nodeKey: { executionId: input.executionId, nodeKey: input.nodeKey } },
      create: {
        executionId: input.executionId,
        nodeKey: input.nodeKey,
        status: 'pending',
        reason: input.reason,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
      update: {}, // idempotente: una revisión existente no se altera al re-crear
    });
    return this.toDomain(row);
  }

  async get(id: string): Promise<PendingReviewRecord | null> {
    const row = await this.prisma.pendingReview.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async listByExecution(executionId: string): Promise<PendingReviewRecord[]> {
    const rows = await this.prisma.pendingReview.findMany({ where: { executionId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.toDomain(r));
  }

  async resolve(
    id: string,
    decision: { approved: boolean; resolvedBy: string; decision: string },
  ): Promise<{ record: PendingReviewRecord; transitioned: boolean }> {
    // Transición ATÓMICA: updateMany filtra por status='pending'. `count === 1` ⇒ esta llamada ganó
    // la carrera; `count === 0` ⇒ ya estaba resuelta (otro request concurrente la resolvió).
    const res = await this.prisma.pendingReview.updateMany({
      where: { id, status: 'pending' },
      data: { status: decision.approved ? 'approved' : 'rejected', decision: decision.decision, resolvedBy: decision.resolvedBy },
    });
    const row = await this.prisma.pendingReview.findUnique({ where: { id } });
    if (!row) throw new Error(`Revisión no encontrada: ${id}`);
    return { record: this.toDomain(row), transitioned: res.count === 1 };
  }

  private toDomain(row: {
    id: string;
    executionId: string;
    nodeKey: string;
    status: string;
    reason: string;
    decision: string | null;
    resolvedBy: string | null;
    createdAt: Date;
    expiresAt: Date | null;
  }): PendingReviewRecord {
    return {
      id: row.id,
      executionId: row.executionId,
      nodeKey: row.nodeKey,
      status: row.status as PendingReviewStatus,
      reason: row.reason,
      decision: row.decision ?? null,
      resolvedBy: row.resolvedBy ?? null,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    };
  }
}
