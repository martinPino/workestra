import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '@core/infra';
import type { INodeRunRepository } from '@core/engine';
import { ExecutionEventHub } from './execution-event-hub';
import type { PersistenceBundle } from '../persistence/bundle';

const noopNodeRuns: INodeRunRepository = {
  async upsert() {},
  async list() {
    return [];
  },
};

function makeHub() {
  const events = new InMemoryEventStore();
  const bundle = { events, nodeRuns: noopNodeRuns } as unknown as PersistenceBundle;
  return { hub: new ExecutionEventHub(bundle), events };
}

describe('ExecutionEventHub.emit (M6, seq atómico por ejecución)', () => {
  it('dos emit() CONCURRENTES obtienen seq distintos y ninguno se pierde', async () => {
    const { hub, events } = makeHub();
    // Sin serialización, ambos leerían lastSeq=-1 → seq 0 → uno se descartaría (append idempotente).
    await Promise.all([
      hub.emit('e1', { type: 'execution.status', status: 'RUNNING' }),
      hub.emit('e1', { type: 'execution.status', status: 'WAITING_HUMAN' }),
    ]);
    const list = await events.list('e1');
    expect(list.map((e) => e.seq)).toEqual([0, 1]); // ambos persistidos, seq consecutivos
  });

  it('emit() continúa la numeración tras eventos ya persistidos (p. ej. del runner)', async () => {
    const { hub, events } = makeHub();
    await events.append({ schemaVersion: 1, executionId: 'e1', at: '2026-01-01T00:00:00.000Z', seq: 4, type: 'node.succeeded', nodeKey: 'a', stepKey: 's' } as never);
    await hub.emit('e1', { type: 'human.resolved', nodeKey: 'a', reviewId: 'r', approved: true, resolvedBy: 'u', decision: 'ok' });
    const list = await events.list('e1');
    expect(list[list.length - 1].seq).toBe(5); // lastSeq(4) + 1
  });
});
