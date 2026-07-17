import type { PrismaClient } from '@prisma/client';
import type { MemoryScope, MemoryEvent } from '@core/contracts';
import type { IMemoryStore } from '@core/engine';

type MemoryEmitter = (e: MemoryEvent) => void;

/**
 * Tope de entradas por clave (M81). `append` es acumulativo y, en la memoria de EQUIPO, una sola clave recoge
 * lo que concluye cada agente del workspace: sin tope, un flujo disparado por webhook la haría crecer sin
 * límite y cada ejecución posterior tendría que releer y reescribir el histórico entero. Nos quedamos con las
 * más RECIENTES: la memoria envejece, no revienta.
 */
const MAX_ENTRIES = 50;

/** Vida de la memoria «solo esta ejecución»: sobrevive al flujo con margen, no para siempre. */
const TEMPORAL_TTL_MS = 24 * 60 * 60 * 1000;

const asArray = (cur: unknown): unknown[] => (Array.isArray(cur) ? [...cur] : cur === undefined ? [] : [cur]);
const capped = (arr: unknown[]): unknown[] => (arr.length > MAX_ENTRIES ? arr.slice(-MAX_ENTRIES) : arr);
const expiryOf = (scope: MemoryScope, now: number): Date | null => (scope === 'temporal' ? new Date(now + TEMPORAL_TTL_MS) : null);

/**
 * Memoria in-memory (modo sin infra). Se acota por `workspaceId` como el resto de puertos: dos workspaces
 * NUNCA comparten clave, ni siquiera con el mismo `ownerId` (p. ej. la memoria de equipo). Emite eventos.
 */
export class InMemoryMemoryStore implements IMemoryStore {
  private readonly data = new Map<string, unknown>();
  constructor(private readonly emit?: MemoryEmitter) {}

  private k(workspaceId: string, scope: MemoryScope, ownerId: string, key: string): string {
    return `${workspaceId}:${scope}:${ownerId}:${key}`;
  }

  async get(workspaceId: string, scope: MemoryScope, ownerId: string, key: string): Promise<unknown | undefined> {
    return this.data.get(this.k(workspaceId, scope, ownerId, key));
  }

  async set(workspaceId: string, scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void> {
    this.data.set(this.k(workspaceId, scope, ownerId, key), value);
    this.emit?.({ type: 'memory.set', scope, ownerId, key });
  }

  async append(workspaceId: string, scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void> {
    const arr = asArray(this.data.get(this.k(workspaceId, scope, ownerId, key)));
    arr.push(value);
    this.data.set(this.k(workspaceId, scope, ownerId, key), capped(arr));
    this.emit?.({ type: 'memory.append', scope, ownerId, key });
  }
}

/**
 * Memoria PERSISTENTE (Postgres). El `workspaceId` viaja en CADA operación (no en el constructor): la API y
 * el worker sirven varios workspaces con UNA sola instancia del store, así que fijarlo al construir mezclaría
 * tenants (sobre todo la memoria de equipo, cuyo `ownerId` es el propio workspace). Emite eventos para que el
 * replay (M6) pueda reconstruirla.
 */
export class PrismaMemoryStore implements IMemoryStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly emit?: MemoryEmitter,
    /** Reloj inyectable: la caducidad debe ser comprobable en test sin esperar 24 h. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Clave única de una entrada: el UNIQUE (workspace, scope, owner, key) permite upsert atómico. */
  private id(workspaceId: string, scope: MemoryScope, ownerId: string, key: string) {
    return { workspaceId_scope_ownerId_key: { workspaceId, scope, ownerId, key } };
  }

  private async write(workspaceId: string, scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void> {
    const expiresAt = expiryOf(scope, this.now());
    await this.prisma.memory.upsert({
      where: this.id(workspaceId, scope, ownerId, key),
      update: { value: value as never, expiresAt },
      create: { workspaceId, scope, ownerId, key, value: value as never, kind: scope, expiresAt },
    });
  }

  async get(workspaceId: string, scope: MemoryScope, ownerId: string, key: string): Promise<unknown | undefined> {
    const row = await this.prisma.memory.findUnique({ where: this.id(workspaceId, scope, ownerId, key) });
    if (!row) return undefined;
    // Caducada: se trata como inexistente aunque la fila siga ahí (la purga es asíncrona).
    if (row.expiresAt && row.expiresAt.getTime() <= this.now()) return undefined;
    return row.value as unknown;
  }

  async set(workspaceId: string, scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void> {
    await this.write(workspaceId, scope, ownerId, key, value);
    this.emit?.({ type: 'memory.set', scope, ownerId, key });
  }

  async append(workspaceId: string, scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void> {
    const arr = asArray(await this.get(workspaceId, scope, ownerId, key));
    arr.push(value);
    await this.write(workspaceId, scope, ownerId, key, capped(arr));
    this.emit?.({ type: 'memory.append', scope, ownerId, key });
  }

  /** Purga la memoria caducada («solo esta ejecución»). Idempotente: puede llamarse desde un job periódico. */
  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.memory.deleteMany({ where: { expiresAt: { lte: new Date(this.now()) } } });
    return count;
  }
}
