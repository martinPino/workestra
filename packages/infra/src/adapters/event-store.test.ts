import { describe, it, expect } from 'vitest';
import type { ExecutionEvent } from '@core/contracts';
import { InMemoryEventStore } from './event-store';

const ev = (seq: number, type = 'execution.started'): ExecutionEvent =>
  ({ schemaVersion: 1, executionId: 'e1', at: '2026-01-01T00:00:00.000Z', seq, type }) as ExecutionEvent;

describe('InMemoryEventStore (M6, append-only idempotente)', () => {
  it('append es idempotente por (executionId, seq): re-publicar no duplica', async () => {
    const store = new InMemoryEventStore();
    await store.append(ev(0));
    await store.append(ev(0, 'execution.failed')); // duplicado (mismo seq): se ignora
    await store.append(ev(1, 'execution.succeeded'));
    const list = await store.list('e1');
    expect(list).toHaveLength(2);
    expect(list[0].type).toBe('execution.started'); // el primero gana
  });

  it('list devuelve el stream ordenado por seq aunque llegue desordenado', async () => {
    const store = new InMemoryEventStore();
    await store.append(ev(2));
    await store.append(ev(0));
    await store.append(ev(1));
    expect((await store.list('e1')).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('lastSeq: -1 sin eventos; el máximo persistido después', async () => {
    const store = new InMemoryEventStore();
    expect(await store.lastSeq('e1')).toBe(-1);
    await store.append(ev(5));
    await store.append(ev(3));
    expect(await store.lastSeq('e1')).toBe(5);
  });

  it('list(sinceSeq): delta-fetch devuelve solo eventos con seq > since (M9)', async () => {
    const store = new InMemoryEventStore();
    for (const s of [0, 1, 2, 3, 4]) await store.append(ev(s));
    expect((await store.list('e1')).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]); // completo por defecto
    expect((await store.list('e1', 2)).map((e) => e.seq)).toEqual([3, 4]); // solo el delta
    expect(await store.list('e1', 4)).toEqual([]); // nada nuevo
  });
});
