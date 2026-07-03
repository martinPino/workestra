import { describe, it, expect } from 'vitest';
import { emptyContext } from '@core/contracts';
import type { IPendingReviewRepository, PendingReviewRecord } from '@core/engine';
import { HumanNodeExecutor } from './human-node';

/** Repo falso mínimo (idempotente por nodo) para no acoplar sdk-plugins a @core/infra. */
class FakeReviewRepo implements IPendingReviewRepository {
  private readonly byId = new Map<string, PendingReviewRecord>();
  private key(e: string, n: string) {
    return `${e}::${n}`;
  }
  async findByNode(e: string, n: string) {
    return this.byId.get(this.key(e, n)) ?? null;
  }
  async create(input: { executionId: string; nodeKey: string; reason: string; expiresAt?: string | null }) {
    const id = this.key(input.executionId, input.nodeKey);
    const existing = this.byId.get(id);
    if (existing) return existing;
    const r: PendingReviewRecord = {
      id,
      executionId: input.executionId,
      nodeKey: input.nodeKey,
      status: 'pending',
      reason: input.reason,
      decision: null,
      resolvedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: input.expiresAt ?? null,
    };
    this.byId.set(id, r);
    return r;
  }
  async get(id: string) {
    return this.byId.get(id) ?? null;
  }
  async listByExecution(e: string) {
    return [...this.byId.values()].filter((r) => r.executionId === e);
  }
  async resolve(id: string, d: { approved: boolean; resolvedBy: string; decision: string }) {
    const r = this.byId.get(id)!;
    if (r.status !== 'pending') return { record: r, transitioned: false };
    const u: PendingReviewRecord = { ...r, status: d.approved ? 'approved' : 'rejected', decision: d.decision, resolvedBy: d.resolvedBy };
    this.byId.set(id, u);
    return { record: u, transitioned: true };
  }
}

const makeCtx = (reviews: FakeReviewRepo, events: unknown[]) => ({
  executionId: 'exec_1',
  nodeKey: 'approve',
  config: { reason: 'Aprobar despliegue' },
  context: emptyContext(),
  signal: new AbortController().signal,
  emit: (e: unknown) => events.push(e),
});

describe('HumanNodeExecutor (human-in-the-loop)', () => {
  it('primera ejecución: crea revisión pending, emite human.requested y pausa', async () => {
    const reviews = new FakeReviewRepo();
    const events: Array<{ type: string }> = [];
    const exec = new HumanNodeExecutor(reviews);

    const res = await exec.execute(makeCtx(reviews, events) as never);

    expect(res.control).toEqual({ kind: 'pause', reason: 'Aprobar despliegue' });
    expect(events.some((e) => e.type === 'human.requested')).toBe(true);
    const pending = await reviews.findByNode('exec_1', 'approve');
    expect(pending?.status).toBe('pending');
  });

  it('re-entrada aprobada: continúa y anota la decisión en el contexto', async () => {
    const reviews = new FakeReviewRepo();
    const events: unknown[] = [];
    const exec = new HumanNodeExecutor(reviews);

    await exec.execute(makeCtx(reviews, events) as never); // pausa + crea revisión
    const review = await reviews.findByNode('exec_1', 'approve');
    await reviews.resolve(review!.id, { approved: true, resolvedBy: 'user_dev', decision: 'ok' });

    const res = await exec.execute(makeCtx(reviews, events) as never); // re-entrada
    expect(res.control).toEqual({ kind: 'continue' });
    expect(res.context.variables['human:approve']).toEqual({ approved: true, decision: 'ok', resolvedBy: 'user_dev' });
  });

  it('re-entrada rechazada: LANZA para que la ejecución falle (no termina en éxito)', async () => {
    const reviews = new FakeReviewRepo();
    const exec = new HumanNodeExecutor(reviews);

    await exec.execute(makeCtx(reviews, []) as never);
    const review = await reviews.findByNode('exec_1', 'approve');
    await reviews.resolve(review!.id, { approved: false, resolvedBy: 'user_dev', decision: 'no' });

    await expect(exec.execute(makeCtx(reviews, []) as never)).rejects.toThrow(/rechazada/);
  });

  it('no crea revisiones duplicadas al re-ejecutar (idempotente por nodo)', async () => {
    const reviews = new FakeReviewRepo();
    const exec = new HumanNodeExecutor(reviews);
    await exec.execute(makeCtx(reviews, []) as never);
    await exec.execute(makeCtx(reviews, []) as never);
    expect((await reviews.listByExecution('exec_1')).length).toBe(1);
  });
});
