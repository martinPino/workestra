import type { Execution, ExecutionStatus, ExecutionContext, ExecutionEvent } from '@core/contracts';
import { emptyContext } from '@core/contracts';
import type {
  IExecutionRepository,
  IContextStore,
  IEventPublisher,
  IClock,
  IIdGenerator,
  NewExecution,
  NewExecutionLog,
} from '@core/engine';

let counter = 0;

/** Adaptadores in-memory: cero dependencias externas. Para tests y el walking skeleton (M1). */
export class InMemoryExecutionRepository implements IExecutionRepository {
  readonly executions = new Map<string, Execution>();
  readonly logs: NewExecutionLog[] = [];

  async create(e: NewExecution): Promise<Execution> {
    const id = `exec_${++counter}`;
    const execution: Execution = {
      id,
      workflowVersionId: e.workflowVersionId,
      workspaceId: e.workspaceId,
      parentExecutionId: e.parentExecutionId ?? null,
      status: 'QUEUED',
      triggerType: e.triggerType as Execution['triggerType'],
      tokensUsed: 0,
      costEstimate: 0,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.executions.set(id, execution);
    return execution;
  }

  async get(id: string): Promise<Execution | null> {
    return this.executions.get(id) ?? null;
  }

  async list(q: { workspaceId: string; status?: ExecutionStatus; limit?: number; workflowVersionIds?: string[] }): Promise<Execution[]> {
    // El Map preserva el orden de inserción; lo invertimos para dar los más recientes primero.
    const all = [...this.executions.values()].reverse();
    const versionSet = q.workflowVersionIds ? new Set(q.workflowVersionIds) : null;
    // Filtra por versiones ANTES del slice (mismo criterio que Prisma): no pierde filas fuera de las N recientes.
    const filtered = all.filter(
      (e) => e.workspaceId === q.workspaceId && (!q.status || e.status === q.status) && (!versionSet || versionSet.has(e.workflowVersionId)),
    );
    return filtered.slice(0, q.limit ?? 50);
  }

  async updateStatus(id: string, status: ExecutionStatus): Promise<void> {
    const ex = this.executions.get(id);
    if (ex) ex.status = status;
  }

  async appendLog(log: NewExecutionLog): Promise<void> {
    this.logs.push(log);
  }

  async addUsage(id: string, tokens: number, cost: number): Promise<void> {
    const ex = this.executions.get(id);
    if (ex) {
      ex.tokensUsed += tokens;
      ex.costEstimate += cost;
    }
  }
}

export class InMemoryContextStore implements IContextStore {
  private readonly store = new Map<string, ExecutionContext>();

  async load(id: string): Promise<ExecutionContext> {
    return this.store.get(id) ?? emptyContext();
  }

  async checkpoint(id: string, ctx: ExecutionContext): Promise<void> {
    this.store.set(id, ctx);
  }
}

export class InMemoryEventPublisher implements IEventPublisher {
  readonly events: ExecutionEvent[] = [];

  async publish(e: ExecutionEvent): Promise<void> {
    this.events.push(e);
  }
}

export class SystemClock implements IClock {
  now(): Date {
    return new Date();
  }
}

export class CuidIdGenerator implements IIdGenerator {
  next(): string {
    return `id_${Date.now().toString(36)}_${(++counter).toString(36)}`;
  }
}
