import type { PrismaClient } from '@prisma/client';
import type { IScheduleRepository, ScheduleRecord, SchedulePoll } from '@core/engine';

type NewSchedule = { workspaceId: string; workflowId: string; cron: string | null; everyMs: number | null; poll?: SchedulePoll | null };

/** Schedule repo in-memory (dev/tests). */
export class InMemoryScheduleRepository implements IScheduleRepository {
  private readonly byId = new Map<string, ScheduleRecord>();
  private seq = 0;

  async create(input: NewSchedule): Promise<ScheduleRecord> {
    const id = `sch_${++this.seq}`;
    const record: ScheduleRecord = { id, active: true, createdAt: new Date(Date.now() + this.seq).toISOString(), ...input };
    this.byId.set(id, record);
    return record;
  }
  async get(id: string): Promise<ScheduleRecord | null> {
    return this.byId.get(id) ?? null;
  }
  async listByWorkflow(workflowId: string): Promise<ScheduleRecord[]> {
    return [...this.byId.values()].filter((s) => s.workflowId === workflowId);
  }
  async listActive(): Promise<ScheduleRecord[]> {
    return [...this.byId.values()].filter((s) => s.active);
  }
  async delete(id: string): Promise<void> {
    this.byId.delete(id);
  }
}

/** Schedule repo durable (Prisma). */
export class PrismaScheduleRepository implements IScheduleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: NewSchedule): Promise<ScheduleRecord> {
    const row = await this.prisma.scheduledTrigger.create({
      data: {
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        cron: input.cron,
        everyMs: input.everyMs,
        poll: (input.poll ?? undefined) as never, // M52: JSON de sondeo
        active: true,
      },
    });
    return this.toDomain(row);
  }
  async get(id: string): Promise<ScheduleRecord | null> {
    const row = await this.prisma.scheduledTrigger.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }
  async listByWorkflow(workflowId: string): Promise<ScheduleRecord[]> {
    const rows = await this.prisma.scheduledTrigger.findMany({ where: { workflowId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.toDomain(r));
  }
  async listActive(): Promise<ScheduleRecord[]> {
    const rows = await this.prisma.scheduledTrigger.findMany({ where: { active: true } });
    return rows.map((r) => this.toDomain(r));
  }
  async delete(id: string): Promise<void> {
    await this.prisma.scheduledTrigger.deleteMany({ where: { id } });
  }

  private toDomain(row: {
    id: string;
    workspaceId: string;
    workflowId: string;
    cron: string | null;
    everyMs: number | null;
    poll?: unknown;
    active: boolean;
    createdAt: Date;
  }): ScheduleRecord {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      workflowId: row.workflowId,
      cron: row.cron,
      everyMs: row.everyMs,
      poll: (row.poll ?? null) as ScheduleRecord['poll'],
      active: row.active,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
