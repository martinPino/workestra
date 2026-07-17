import { describe, it, expect } from 'vitest';
import { emptyContext, type ExecutionContext, type MemoryScope } from '@core/contracts';
import type { IMemoryStore } from '@core/engine';
import { HandoffService } from './handoff';

const ctx = (): ExecutionContext => ({
  ...emptyContext(),
  ticket: { id: 'JIRA-1', title: 'Arreglar login' },
  repository: { name: 'app' },
  variables: { public: 'ok', 'agent:secreto': 'no-compartir', otra: 42 },
});

const WS = 'ws_1';

class FakeMemory implements IMemoryStore {
  private readonly store = new Map<string, unknown>();
  private k(ws: string, s: MemoryScope, o: string, key: string) {
    return `${ws}/${s}/${o}/${key}`;
  }
  async get(ws: string, s: MemoryScope, o: string, key: string) {
    return this.store.get(this.k(ws, s, o, key));
  }
  async set(ws: string, s: MemoryScope, o: string, key: string, v: unknown) {
    this.store.set(this.k(ws, s, o, key), v);
  }
  async append(ws: string, s: MemoryScope, o: string, key: string, v: unknown) {
    const prev = (this.store.get(this.k(ws, s, o, key)) as unknown[]) ?? [];
    this.store.set(this.k(ws, s, o, key), [...prev, v]);
  }
}

describe('HandoffService (context-slicing, mínimo privilegio)', () => {
  it('solo propaga las variables autorizadas (deny-by-default) + marco de tarea', async () => {
    const svc = new HandoffService();
    const h = await svc.slice({
      fromAgentId: 'orch',
      toAgentId: 'qa',
      task: 'Escribe tests',
      context: ctx(),
      includeVariableKeys: ['public', 'inexistente'],
    });
    expect(h.variables).toEqual({ public: 'ok' }); // 'agent:secreto' y 'otra' NO viajan
    expect(h.ticket).toEqual({ id: 'JIRA-1', title: 'Arreglar login' });
    expect(h.repository).toEqual({ name: 'app' });
  });

  // La memoria de EQUIPO la escribe el runtime con el WORKSPACE como owner (M81); leerla por el id del agente
  // destino apuntaba a un namespace que nadie escribe y el handoff adjuntaba siempre vacío.
  it('adjunta la memoria de equipo (owner = workspace) en orden determinista', async () => {
    const mem = new FakeMemory();
    await mem.set(WS, 'shared', WS, 'b', 2);
    await mem.set(WS, 'shared', WS, 'a', 1);
    await mem.set(WS, 'shared', 'qa', 'a', 999); // otro owner (no es la memoria de equipo): NO se incluye
    await mem.set('ws_2', 'shared', 'ws_2', 'a', 999); // otro tenant: NO se incluye
    const svc = new HandoffService(mem);
    const h = await svc.slice({
      fromAgentId: 'orch',
      toAgentId: 'qa',
      task: 't',
      context: ctx(),
      includeMemoryKeys: ['b', 'a', 'ausente'],
      workspaceId: WS,
    });
    expect(h.memory).toEqual([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
    ]); // ordenado por clave, solo del owner destino, sin la ausente
  });

  it('toContext materializa una rebanada acotada con la tarea en variables', async () => {
    const svc = new HandoffService();
    const out = await svc.toContext({
      fromAgentId: 'orch',
      toAgentId: 'be',
      task: 'Implementa endpoint',
      context: ctx(),
      includeVariableKeys: ['public'],
    });
    expect(out.variables).toEqual({ public: 'ok', task: 'Implementa endpoint' });
    expect(out.variables['agent:secreto']).toBeUndefined();
    expect(out.ticket).toEqual({ id: 'JIRA-1', title: 'Arreglar login' });
  });
});
