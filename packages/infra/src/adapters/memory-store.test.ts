import { describe, it, expect } from 'vitest';
import type { MemoryEvent } from '@core/contracts';
import { InMemoryMemoryStore } from './memory-store';

describe('MemoryStore emite eventos (habilita el replay de M6)', () => {
  it('emite memory.set y memory.append en cada escritura', async () => {
    const events: MemoryEvent[] = [];
    const store = new InMemoryMemoryStore((e) => events.push(e));

    await store.set('persistent', 'agent_1', 'summary', 'v1');
    await store.append('shared', 'agent_1', 'notes', 'nota-1');

    expect(events).toEqual([
      { type: 'memory.set', scope: 'persistent', ownerId: 'agent_1', key: 'summary' },
      { type: 'memory.append', scope: 'shared', ownerId: 'agent_1', key: 'notes' },
    ]);
  });

  it('append acumula en un array', async () => {
    const store = new InMemoryMemoryStore();
    await store.append('shared', 'a', 'k', 1);
    await store.append('shared', 'a', 'k', 2);
    expect(await store.get('shared', 'a', 'k')).toEqual([1, 2]);
  });
});
