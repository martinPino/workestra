import type { PrismaClient } from '@prisma/client';
import type { IApiKeyRepository, ApiKeyRecord } from '@core/engine';
import type { Role } from '@core/contracts';

type NewApiKey = {
  workspaceId: string;
  userSub: string;
  email: string;
  role: Role;
  hashedKey: string;
  prefix: string;
  last4: string;
  label: string;
};

/** Claves de API in-memory (dev/tests). */
export class InMemoryApiKeyRepository implements IApiKeyRepository {
  private readonly byId = new Map<string, ApiKeyRecord>();
  private seq = 0;

  async create(input: NewApiKey): Promise<ApiKeyRecord> {
    const id = `ak_${++this.seq}`;
    const record: ApiKeyRecord = { id, createdAt: new Date(), lastUsedAt: null, revokedAt: null, ...input };
    this.byId.set(id, record);
    return record;
  }
  async findByHash(hashedKey: string): Promise<ApiKeyRecord | null> {
    for (const k of this.byId.values()) {
      if (k.hashedKey === hashedKey && !k.revokedAt) return k;
    }
    return null;
  }
  async listByWorkspace(workspaceId: string): Promise<ApiKeyRecord[]> {
    return [...this.byId.values()]
      .filter((k) => k.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async revoke(id: string, workspaceId: string): Promise<ApiKeyRecord | null> {
    const k = this.byId.get(id);
    if (!k || k.workspaceId !== workspaceId) return null;
    const updated = { ...k, revokedAt: k.revokedAt ?? new Date() };
    this.byId.set(id, updated);
    return updated;
  }
  async touchLastUsed(id: string): Promise<void> {
    const k = this.byId.get(id);
    if (k) this.byId.set(id, { ...k, lastUsedAt: new Date() });
  }
}

/** Claves de API durables (Prisma). Solo se guarda el hash; la clave en claro nunca toca la BD. */
export class PrismaApiKeyRepository implements IApiKeyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: NewApiKey): Promise<ApiKeyRecord> {
    const row = await this.prisma.apiKey.create({ data: input });
    return this.toDomain(row);
  }
  async findByHash(hashedKey: string): Promise<ApiKeyRecord | null> {
    const row = await this.prisma.apiKey.findFirst({ where: { hashedKey, revokedAt: null } });
    return row ? this.toDomain(row) : null;
  }
  async listByWorkspace(workspaceId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.prisma.apiKey.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toDomain(r));
  }
  async revoke(id: string, workspaceId: string): Promise<ApiKeyRecord | null> {
    // updateMany acota por workspace (deny-by-default) y es idempotente si ya estaba revocada.
    const res = await this.prisma.apiKey.updateMany({
      where: { id, workspaceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) {
      const existing = await this.prisma.apiKey.findFirst({ where: { id, workspaceId } });
      return existing ? this.toDomain(existing) : null;
    }
    const row = await this.prisma.apiKey.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }
  async touchLastUsed(id: string): Promise<void> {
    // Best-effort: no debe tumbar la petición de auth si falla (p. ej. carrera con un revoke).
    await this.prisma.apiKey.updateMany({ where: { id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }

  private toDomain(row: {
    id: string;
    workspaceId: string;
    userSub: string;
    email: string;
    role: string;
    hashedKey: string;
    prefix: string;
    last4: string;
    label: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  }): ApiKeyRecord {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      userSub: row.userSub,
      email: row.email,
      role: row.role as Role,
      hashedKey: row.hashedKey,
      prefix: row.prefix,
      last4: row.last4,
      label: row.label,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
    };
  }
}
