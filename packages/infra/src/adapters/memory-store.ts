import type { PrismaClient } from '@prisma/client';
import type { MemoryScope, MemoryEvent } from '@core/contracts';
import type { IMemoryStore } from '@core/engine';

type MemoryEmitter = (e: MemoryEvent) => void;

const asArray = (cur: unknown): unknown[] => (Array.isArray(cur) ? [...cur] : cur === undefined ? [] : [cur]);

/** Memoria in-memory (scope temporal por defecto). Emite eventos en cada escritura. */
export class InMemoryMemoryStore implements IMemoryStore {
  private readonly data = new Map<string, unknown>();
  constructor(private readonly emit?: MemoryEmitter) {}

  private k(scope: MemoryScope, ownerId: string, key: string): string {
    return `${scope}:${ownerId}:${key}`;
  }

  async get(scope: MemoryScope, ownerId: string, key: string): Promise<unknown | undefined> {
    return this.data.get(this.k(scope, ownerId, key));
  }

  async set(scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void> {
    this.data.set(this.k(scope, ownerId, key), value);
    this.emit?.({ type: 'memory.set', scope, ownerId, key });
  }

  async append(scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void> {
    const arr = asArray(this.data.get(this.k(scope, ownerId, key)));
    arr.push(value);
    this.data.set(this.k(scope, ownerId, key), arr);
    this.emit?.({ type: 'memory.append', scope, ownerId, key });
  }
}

/** Memoria PERSISTENTE (Postgres). Emite eventos para que el replay de M6 pueda reconstruirla. */
export class PrismaMemoryStore implements IMemoryStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly workspaceId: string,
    private readonly emit?: MemoryEmitter,
  ) {}

  private where(scope: MemoryScope, ownerId: string, key: string) {
    return { workspaceId: this.workspaceId, scope, ownerId, key };
  }

  private async write(scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void> {
    const existing = await this.prisma.memory.findFirst({ where: this.where(scope, ownerId, key) });
    if (existing) {

      await this.prisma.memory.update({ where: { id: existing.id }, data: { value: value as any } });
    } else {
      await this.prisma.memory.create({

        data: { workspaceId: this.workspaceId, scope, ownerId, key, value: value as any, kind: scope },
      });
    }
  }

  async get(scope: MemoryScope, ownerId: string, key: string): Promise<unknown | undefined> {
    const row = await this.prisma.memory.findFirst({ where: this.where(scope, ownerId, key) });
    return row?.value as unknown;
  }

  async set(scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void> {
    await this.write(scope, ownerId, key, value);
    this.emit?.({ type: 'memory.set', scope, ownerId, key });
  }

  async append(scope: MemoryScope, ownerId: string, key: string, value: unknown): Promise<void> {
    const arr = asArray(await this.get(scope, ownerId, key));
    arr.push(value);
    await this.write(scope, ownerId, key, arr);
    this.emit?.({ type: 'memory.append', scope, ownerId, key });
  }
}
