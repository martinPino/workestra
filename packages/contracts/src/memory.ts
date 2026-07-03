/** Tipos de la memoria de agentes/workflows. */

export type MemoryScope = 'temporal' | 'persistent' | 'shared';

export interface MemoryEntry {
  scope: MemoryScope;
  ownerId: string;
  key: string;
  value: unknown;
}

/** Evento emitido en cada escritura de memoria (habilita el replay de M6). */
export interface MemoryEvent {
  type: 'memory.set' | 'memory.append';
  scope: MemoryScope;
  ownerId: string;
  key: string;
}
