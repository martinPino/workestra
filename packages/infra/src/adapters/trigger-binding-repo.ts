import type { PrismaClient } from '@prisma/client';
import type { ITriggerBindingRepository, TriggerBindingRecord } from '@core/engine';

type NewBinding = {
  workspaceId: string;
  workflowId: string;
  eventId: string;
  connectorId: string;
  webhookId: string;
  remoteId: string | null;
  params: Record<string, unknown>;
};

/** Binding de disparador in-memory (dev/tests). */
export class InMemoryTriggerBindingRepository implements ITriggerBindingRepository {
  private readonly byId = new Map<string, TriggerBindingRecord>();
  private seq = 0;

  async create(input: NewBinding): Promise<TriggerBindingRecord> {
    const id = `tb_${++this.seq}`;
    const record: TriggerBindingRecord = { id, active: true, createdAt: new Date().toISOString(), ...input };
    this.byId.set(id, record);
    return record;
  }
  async get(id: string): Promise<TriggerBindingRecord | null> {
    return this.byId.get(id) ?? null;
  }
  async listByWorkflow(workflowId: string): Promise<TriggerBindingRecord[]> {
    return [...this.byId.values()].filter((b) => b.workflowId === workflowId);
  }
  async listActive(): Promise<TriggerBindingRecord[]> {
    return [...this.byId.values()].filter((b) => b.active);
  }
  async setActive(id: string, active: boolean): Promise<void> {
    const b = this.byId.get(id);
    if (b) this.byId.set(id, { ...b, active });
  }
  async delete(id: string): Promise<void> {
    this.byId.delete(id);
  }
}

/** Binding de disparador durable (Prisma). `params` se guarda como JSONB; `remoteId` como CSV de ids. */
export class PrismaTriggerBindingRepository implements ITriggerBindingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: NewBinding): Promise<TriggerBindingRecord> {
    const row = await this.prisma.triggerBinding.create({
      data: {
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        eventId: input.eventId,
        connectorId: input.connectorId,
        webhookId: input.webhookId,
        remoteId: input.remoteId,
        params: input.params as object,
        active: true,
      },
    });
    return this.toDomain(row);
  }
  async get(id: string): Promise<TriggerBindingRecord | null> {
    const row = await this.prisma.triggerBinding.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }
  async listByWorkflow(workflowId: string): Promise<TriggerBindingRecord[]> {
    const rows = await this.prisma.triggerBinding.findMany({ where: { workflowId } });
    return rows.map((r) => this.toDomain(r));
  }
  async listActive(): Promise<TriggerBindingRecord[]> {
    const rows = await this.prisma.triggerBinding.findMany({ where: { active: true } });
    return rows.map((r) => this.toDomain(r));
  }
  async setActive(id: string, active: boolean): Promise<void> {
    await this.prisma.triggerBinding.update({ where: { id }, data: { active } });
  }
  async delete(id: string): Promise<void> {
    await this.prisma.triggerBinding.deleteMany({ where: { id } });
  }

  private toDomain(row: {
    id: string;
    workspaceId: string;
    workflowId: string;
    eventId: string;
    connectorId: string;
    webhookId: string;
    remoteId: string | null;
    params: unknown;
    active: boolean;
    createdAt: Date;
  }): TriggerBindingRecord {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      workflowId: row.workflowId,
      eventId: row.eventId,
      connectorId: row.connectorId,
      webhookId: row.webhookId,
      remoteId: row.remoteId,
      params: (row.params ?? {}) as Record<string, unknown>,
      active: row.active,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
