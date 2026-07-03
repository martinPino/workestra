import type { PrismaClient } from '@prisma/client';
import type { IConnectorRepository, ConnectorRecord } from '@core/engine';

type NewConnector = { workspaceId: string; key: string; provider: string };

const normalizeStatus = (s: string): ConnectorRecord['status'] => (s === 'connected' ? 'connected' : 'disconnected');

/** Connector repo in-memory (dev/tests). */
export class InMemoryConnectorRepository implements IConnectorRepository {
  private readonly byId = new Map<string, ConnectorRecord>();
  private seq = 0;

  async create(input: NewConnector): Promise<ConnectorRecord> {
    const id = `conn_${++this.seq}`;
    const record: ConnectorRecord = { id, status: 'disconnected', credentialsSecretId: null, ...input };
    this.byId.set(id, record);
    return record;
  }
  async getInWorkspace(id: string, workspaceId: string): Promise<ConnectorRecord | null> {
    const c = this.byId.get(id);
    return c && c.workspaceId === workspaceId ? c : null;
  }
  async listByWorkspace(workspaceId: string): Promise<ConnectorRecord[]> {
    return [...this.byId.values()].filter((c) => c.workspaceId === workspaceId);
  }
  async setConnected(id: string, credentialsSecretId: string): Promise<void> {
    const c = this.byId.get(id);
    if (c) this.byId.set(id, { ...c, status: 'connected', credentialsSecretId });
  }
  async delete(id: string): Promise<ConnectorRecord | null> {
    const c = this.byId.get(id) ?? null;
    this.byId.delete(id);
    return c;
  }
}

/** Connector repo durable (Prisma). El token OAuth vive cifrado en el ISecretStore, no aquí. */
export class PrismaConnectorRepository implements IConnectorRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: NewConnector): Promise<ConnectorRecord> {
    const row = await this.prisma.connector.create({
      data: { workspaceId: input.workspaceId, key: input.key, provider: input.provider, status: 'disconnected' },
    });
    return this.toDomain(row);
  }
  async getInWorkspace(id: string, workspaceId: string): Promise<ConnectorRecord | null> {
    const row = await this.prisma.connector.findFirst({ where: { id, workspaceId } });
    return row ? this.toDomain(row) : null;
  }
  async listByWorkspace(workspaceId: string): Promise<ConnectorRecord[]> {
    const rows = await this.prisma.connector.findMany({ where: { workspaceId } });
    return rows.map((r) => this.toDomain(r));
  }
  async setConnected(id: string, credentialsSecretId: string): Promise<void> {
    await this.prisma.connector.update({ where: { id }, data: { status: 'connected', credentialsSecretId } });
  }
  async delete(id: string): Promise<ConnectorRecord | null> {
    const row = await this.prisma.connector.findUnique({ where: { id } });
    if (!row) return null;
    await this.prisma.connector.deleteMany({ where: { id } });
    return this.toDomain(row);
  }

  private toDomain(row: {
    id: string;
    workspaceId: string;
    key: string;
    provider: string;
    status: string;
    credentialsSecretId: string | null;
  }): ConnectorRecord {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      key: row.key,
      provider: row.provider,
      status: normalizeStatus(row.status),
      credentialsSecretId: row.credentialsSecretId,
    };
  }
}
