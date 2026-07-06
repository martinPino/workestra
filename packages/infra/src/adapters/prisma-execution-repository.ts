import type { PrismaClient } from '@prisma/client';
import type { Execution, ExecutionStatus } from '@core/contracts';
import type { IExecutionRepository, NewExecution, NewExecutionLog, ExecutionListQuery } from '@core/engine';

/** Adaptador Prisma del puerto IExecutionRepository (producción). */
export class PrismaExecutionRepository implements IExecutionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(e: NewExecution): Promise<Execution> {
    const row = await this.prisma.execution.create({
      data: {
        workflowVersionId: e.workflowVersionId,
        workspaceId: e.workspaceId,
        parentExecutionId: e.parentExecutionId ?? null,
        status: 'QUEUED',
        triggerType: e.triggerType,
        context: e.context as any,
      },
    });
    return this.toDomain(row);
  }

  async get(id: string): Promise<Execution | null> {
    const row = await this.prisma.execution.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async list(q: ExecutionListQuery): Promise<Execution[]> {
    const rows = await this.prisma.execution.findMany({
      where: { workspaceId: q.workspaceId, ...(q.status ? { status: q.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 50,
    });
    return rows.map((r) => this.toDomain(r));
  }

  async updateStatus(id: string, status: ExecutionStatus): Promise<void> {
    await this.prisma.execution.update({ where: { id }, data: { status } });
  }

  async addUsage(id: string, tokens: number, cost: number): Promise<void> {
    await this.prisma.execution.update({
      where: { id },
      data: { tokensUsed: { increment: tokens }, costEstimate: { increment: cost } },
    });
  }

  async appendLog(log: NewExecutionLog): Promise<void> {
    // UPSERT por (executionId, stepKey): el stepKey es idempotente por (exec, nodo, intento). Al
    // reanudar un nodo pausado (Humano), este re-ejecuta con el mismo stepKey y su fila `paused`
    // debe ACTUALIZARSE a `ok`/`failed`, no colisionar con la unique. Sin esto, el resume peta.
    const data = {
      executionId: log.executionId,
      nodeKey: log.nodeKey,
      stepKey: log.stepKey,
      level: log.level,
      status: log.status,
      input: (log.input ?? undefined) as any,
      output: (log.output ?? undefined) as any,
      tokens: log.tokens ?? 0,
      cost: log.cost ?? 0,
      durationMs: log.durationMs ?? 0,
    };
    await this.prisma.executionLog.upsert({
      where: { executionId_stepKey: { executionId: log.executionId, stepKey: log.stepKey } },
      create: data,
      update: {
        level: data.level,
        status: data.status,
        output: data.output,
        tokens: data.tokens,
        cost: data.cost,
        durationMs: data.durationMs,
      },
    });
  }

  private toDomain(row: any): Execution {
    return {
      id: row.id,
      workflowVersionId: row.workflowVersionId,
      workspaceId: row.workspaceId,
      parentExecutionId: row.parentExecutionId ?? null,
      status: row.status,
      triggerType: row.triggerType,
      tokensUsed: row.tokensUsed,
      costEstimate: Number(row.costEstimate),
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    };
  }
}
