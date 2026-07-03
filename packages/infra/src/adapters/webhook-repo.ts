import type { PrismaClient } from '@prisma/client';
import type { IWebhookRepository, WebhookRecord } from '@core/engine';

type NewWebhook = { workspaceId: string; workflowId: string; event: string; url: string; signingSecretKey: string };

/** Webhook repo in-memory (dev/tests). El id hace de token de ingreso. */
export class InMemoryWebhookRepository implements IWebhookRepository {
  private readonly byId = new Map<string, WebhookRecord>();
  private seq = 0;

  async create(input: NewWebhook): Promise<WebhookRecord> {
    const id = `wh_${++this.seq}`;
    const record: WebhookRecord = { id, active: true, ...input };
    this.byId.set(id, record);
    return record;
  }
  async get(id: string): Promise<WebhookRecord | null> {
    return this.byId.get(id) ?? null;
  }
  async listByWorkflow(workflowId: string): Promise<WebhookRecord[]> {
    return [...this.byId.values()].filter((w) => w.workflowId === workflowId);
  }
  async setUrlAndSecret(id: string, url: string, signingSecretKey: string): Promise<WebhookRecord> {
    const w = this.byId.get(id);
    if (!w) throw new Error(`Webhook no encontrado: ${id}`);
    const updated = { ...w, url, signingSecretKey };
    this.byId.set(id, updated);
    return updated;
  }
  async delete(id: string): Promise<void> {
    this.byId.delete(id);
  }
}

/** Webhook repo durable (Prisma). Mapea `signingSecretId` ⇄ clave del secreto de firma. */
export class PrismaWebhookRepository implements IWebhookRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: NewWebhook): Promise<WebhookRecord> {
    const row = await this.prisma.webhook.create({
      data: {
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        event: input.event,
        url: input.url,
        signingSecretId: input.signingSecretKey,
        active: true,
      },
    });
    return this.toDomain(row);
  }
  async get(id: string): Promise<WebhookRecord | null> {
    const row = await this.prisma.webhook.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }
  async listByWorkflow(workflowId: string): Promise<WebhookRecord[]> {
    const rows = await this.prisma.webhook.findMany({ where: { workflowId } });
    return rows.map((r) => this.toDomain(r));
  }
  async setUrlAndSecret(id: string, url: string, signingSecretKey: string): Promise<WebhookRecord> {
    const row = await this.prisma.webhook.update({ where: { id }, data: { url, signingSecretId: signingSecretKey } });
    return this.toDomain(row);
  }
  async delete(id: string): Promise<void> {
    await this.prisma.webhook.deleteMany({ where: { id } });
  }

  private toDomain(row: {
    id: string;
    workspaceId: string;
    workflowId: string;
    event: string;
    url: string;
    signingSecretId: string;
    active: boolean;
  }): WebhookRecord {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      workflowId: row.workflowId,
      event: row.event,
      url: row.url,
      signingSecretKey: row.signingSecretId,
      active: row.active,
    };
  }
}
