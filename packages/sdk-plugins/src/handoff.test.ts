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

class FakeMemory implements IMemoryStore {
  private readonly store = new Map<string, unknown>();
  private k(s: MemoryScope, o: string, key: string) {
    return `${s}/${o}/${key}`;
  }
  async get(s: MemoryScope, o: string, key: string) {
    return this.store.get(this.k(s, o, key));
  }
  async set(s: MemoryScope, o: string, key: string, v: unknown) {
    this.store.set(this.k(s, o, key), v);
  }
  async append(s: MemoryScope, o: string, key: string, v: unknown) {
    const prev = (this.store.get(this.k(s, o, key)) as unknown[]) ?? [];
    this.store.set(this.k(s, o, key), [...prev, v]);
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

  it('adjunta memoria compartida del agente destino en orden determinista', async () => {
    const mem = new FakeMemory();
    await mem.set('shared', 'qa', 'b', 2);
    await mem.set('shared', 'qa', 'a', 1);
    await mem.set('shared', 'otro', 'a', 999); // de otro owner: NO se incluye
    const svc = new HandoffService(mem);
    const h = await svc.slice({
      fromAgentId: 'orch',
      toAgentId: 'qa',
      task: 't',
      context: ctx(),
      includeMemoryKeys: ['b', 'a', 'ausente'],
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
