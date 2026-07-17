import { describe, it, expect } from 'vitest';
import type { MemoryEvent } from '@core/contracts';
import { InMemoryMemoryStore } from './memory-store';

const WS = 'ws_1';

describe('MemoryStore emite eventos (habilita el replay de M6)', () => {
  it('emite memory.set y memory.append en cada escritura', async () => {
    const events: MemoryEvent[] = [];
    const store = new InMemoryMemoryStore((e) => events.push(e));

    await store.set(WS, 'persistent', 'agent_1', 'summary', 'v1');
    await store.append(WS, 'shared', 'agent_1', 'notes', 'nota-1');

    expect(events).toEqual([
      { type: 'memory.set', scope: 'persistent', ownerId: 'agent_1', key: 'summary' },
      { type: 'memory.append', scope: 'shared', ownerId: 'agent_1', key: 'notes' },
    ]);
  });

  it('append acumula en un array', async () => {
    const store = new InMemoryMemoryStore();
    await store.append(WS, 'shared', 'a', 'k', 1);
    await store.append(WS, 'shared', 'a', 'k', 2);
    expect(await store.get(WS, 'shared', 'a', 'k')).toEqual([1, 2]);
  });

  // M81: la memoria de EQUIPO usa el workspace como `ownerId`; sin aislar por workspace, dos tenants
  // distintos compartirían la misma clave y se leerían los recuerdos entre sí.
  it('aísla por workspace: mismo scope/owner/key en otro workspace NO se ve', async () => {
    const store = new InMemoryMemoryStore();
    await store.set('ws_a', 'shared', 'team', 'k', 'secreto-de-A');
    expect(await store.get('ws_b', 'shared', 'team', 'k')).toBeUndefined();
    expect(await store.get('ws_a', 'shared', 'team', 'k')).toBe('secreto-de-A');
  });

  // M81: `append` es acumulativo y en la memoria de equipo una sola clave recoge lo de todos los agentes del
  // workspace. Sin tope, un flujo disparado por webhook la haría crecer sin límite y cada ejecución posterior
  // tendría que releer y reescribir el histórico entero.
  it('append conserva las últimas 50 entradas y descarta las más antiguas', async () => {
    const store = new InMemoryMemoryStore();
    for (let i = 0; i < 60; i++) await store.append(WS, 'shared', 'team', 'notes', i);
    const got = (await store.get(WS, 'shared', 'team', 'notes')) as number[];
    expect(got).toHaveLength(50);
    expect(got[0]).toBe(10); // las 10 primeras se cayeron
    expect(got.at(-1)).toBe(59);
  });
});
