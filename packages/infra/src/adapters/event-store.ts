import type { PrismaClient } from '@prisma/client';
import type { ExecutionEvent } from '@core/contracts';
import type { IEventStore, IEventPublisher } from '@core/engine';

/**
 * EventStore in-memory (tests / modo memory). Idempotente por (executionId, seq): un evento
 * re-publicado (retry del worker, doble camino Redis→hub) se ignora en vez de duplicarse.
 */
export class InMemoryEventStore implements IEventStore {
  private readonly byExec = new Map<string, Map<number, ExecutionEvent>>();

  async append(e: ExecutionEvent): Promise<void> {
    const events = this.byExec.get(e.executionId) ?? new Map<number, ExecutionEvent>();
    const existing = events.get(e.seq);
    if (existing) {
      // Mismo (execId, seq) con tipo DISTINTO = colisión real (no un re-append idempotente): la
      // dejamos ver en vez de tragárnosla en silencio. El mismo tipo se ignora (idempotente).
      if (existing.type !== e.type) {
        console.warn(`[event-store] colisión de seq ${e.seq} en ${e.executionId}: '${existing.type}' vs '${e.type}' (se conserva el primero)`);
      }
    } else {
      events.set(e.seq, e);
    }
    this.byExec.set(e.executionId, events);
  }

  async list(executionId: string, sinceSeq = -1): Promise<ExecutionEvent[]> {
    const events = this.byExec.get(executionId);
    if (!events) return [];
    return [...events.values()].filter((e) => e.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }

  async lastSeq(executionId: string): Promise<number> {
    const events = this.byExec.get(executionId);
    if (!events || events.size === 0) return -1;
    return Math.max(...events.keys());
  }
}

/**
 * EventStore durable en Postgres (M6). El evento completo se guarda como JSON (`payload`) y las
 * columnas (seq, type, at) permiten ordenar/consultar. `createMany + skipDuplicates` sobre la
 * unique (executionId, seq) da la idempotencia sin round-trip extra.
 */
export class PrismaEventStore implements IEventStore {
  constructor(private readonly prisma: PrismaClient) {}

  async append(e: ExecutionEvent): Promise<void> {
    await this.prisma.executionEventRecord.createMany({
      data: [
        {
          executionId: e.executionId,
          seq: e.seq,
          type: e.type,
          at: new Date(e.at),
          payload: e as object,
        },
      ],
      skipDuplicates: true,
    });
  }

  async list(executionId: string, sinceSeq = -1): Promise<ExecutionEvent[]> {
    const rows = await this.prisma.executionEventRecord.findMany({
      where: { executionId, seq: { gt: sinceSeq } },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => r.payload as unknown as ExecutionEvent);
  }

  async lastSeq(executionId: string): Promise<number> {
    const agg = await this.prisma.executionEventRecord.aggregate({
      where: { executionId },
      _max: { seq: true },
    });
    return agg._max.seq ?? -1;
  }
}

/** Publisher que PERSISTE cada evento en el store (para componer en el CompositeEventPublisher del worker). */
export class EventStorePublisher implements IEventPublisher {
  constructor(private readonly store: IEventStore) {}
  async publish(e: ExecutionEvent): Promise<void> {
    await this.store.append(e);
  }
}
