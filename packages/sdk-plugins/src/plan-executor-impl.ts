import type { Agent, ExecutionContext, IAgentRuntime } from '@core/contracts';
import {
  createScheduler,
  mergeContexts,
  type Plan,
  type Subtask,
  type PlanExecutor,
  type PlanExecutorConfig,
  type PlanExecutionResult,
  type SubtaskPolicy,
  type ContextContribution,
} from '@core/domain';
import { HandoffService } from './handoff';

interface SubtaskOutcome {
  subtaskId: string;
  output: string;
  context: ExecutionContext;
  tokens: number;
  cost: number;
}

/**
 * PlanExecutor por defecto. En modo `durable` ejecuta el sub-DAG del plan por READINESS (conjunto
 * de subtareas listas en PARALELO, fan-in determinista con `mergeContexts`), con:
 *  - reintentos POR subtarea (`subtask.policy` sobreescribe el default del executor),
 *  - PRESUPUESTO global (tokens/coste): al excederse tras un nivel, aborta el plan (no sigue gastando),
 *  - selección de agente PLUGGABLE (`selectionStrategy`, p. ej. por capacidades),
 *  - HANDOFF de contexto con mínimo privilegio cuando la subtarea declara `handoff`.
 * En modo `sequential` (M3b) las despacha de una en una. Reutiliza el mismo scheduler que el motor.
 */
export class DefaultPlanExecutor implements PlanExecutor {
  private readonly handoff = new HandoffService();

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly config: PlanExecutorConfig = { mode: 'durable' },
  ) {}

  async execute(
    plan: Plan,
    initialContext: ExecutionContext,
    agents: Map<string, Agent>,
    emit: (event: unknown) => void,
    workspaceId?: string,
  ): Promise<PlanExecutionResult> {
    const scheduler = createScheduler({
      nodes: plan.subtasks.map((s) => ({ key: s.id, type: 'agent', config: {}, position: { x: 0, y: 0 } })),
      edges: plan.edges,
    });
    const defaultPolicy: SubtaskPolicy = this.config.subtaskPolicy ?? { maxAttempts: 1, backoffMs: 0 };

    const completed = new Set<string>();
    const results: Record<string, string> = {};
    let ctx = initialContext;
    let totalTokens = 0;
    let totalCost = 0;

    try {
      while (!scheduler.isComplete(completed)) {
        const ready = scheduler.ready(completed);
        if (ready.length === 0) break;

        const baseCtx = ctx;
        const run = (id: string) => this.runSubtask(plan, id, baseCtx, agents, emit, defaultPolicy, workspaceId);
        const outcomes = this.config.mode === 'sequential' ? await this.serial(ready, run) : await Promise.all(ready.map(run));

        const contributions: ContextContribution[] = outcomes.map((o) => ({ nodeKey: o.subtaskId, context: o.context }));
        ctx = mergeContexts(baseCtx, contributions);
        for (const o of outcomes) {
          results[o.subtaskId] = o.output;
          totalTokens += o.tokens;
          totalCost += o.cost;
          completed.add(o.subtaskId);
        }

        // Presupuesto global: si tras este nivel se excede el tope, aborta ANTES de despachar más.
        this.enforceBudget(totalTokens, totalCost, emit);
      }
    } catch (err) {
      emit({ type: 'plan.execution_failed', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }

    return { context: ctx, results, totalTokens, totalCost };
  }

  private enforceBudget(totalTokens: number, totalCost: number, emit: (e: unknown) => void): void {
    const b = this.config.budget;
    if (!b) return;
    if (b.maxTokens != null && totalTokens > b.maxTokens) {
      emit({ type: 'plan.budget_exceeded', kind: 'tokens', used: totalTokens, limit: b.maxTokens });
      throw new Error(`Presupuesto de tokens excedido: ${totalTokens} > ${b.maxTokens}`);
    }
    if (b.maxCost != null && totalCost > b.maxCost) {
      emit({ type: 'plan.budget_exceeded', kind: 'cost', used: totalCost, limit: b.maxCost });
      throw new Error(`Presupuesto de coste excedido: ${totalCost} > ${b.maxCost}`);
    }
  }

  private async serial<T>(items: string[], fn: (x: string) => Promise<T>): Promise<T[]> {
    const out: T[] = [];
    for (const it of items) out.push(await fn(it));
    return out;
  }

  private policyFor(st: Subtask, fallback: SubtaskPolicy): SubtaskPolicy {
    return {
      maxAttempts: Math.max(1, st.policy?.maxAttempts ?? fallback.maxAttempts),
      backoffMs: Math.max(0, st.policy?.backoffMs ?? fallback.backoffMs),
    };
  }

  private async runSubtask(
    plan: Plan,
    subtaskId: string,
    baseCtx: ExecutionContext,
    agents: Map<string, Agent>,
    emit: (event: unknown) => void,
    defaultPolicy: SubtaskPolicy,
    workspaceId?: string,
  ): Promise<SubtaskOutcome> {
    const st = plan.subtasks.find((s) => s.id === subtaskId)!;
    emit({ type: 'subtask.started', subtaskId: st.id, agentId: st.agentId });

    const agent = await this.resolveAgent(st, agents);
    if (!agent) {
      emit({ type: 'subtask.failed', subtaskId: st.id, error: `Agente no encontrado: ${st.agentId}` });
      throw new Error(`Agente no encontrado para la subtarea ${st.id}: ${st.agentId}`);
    }

    // Handoff con mínimo privilegio: si la subtarea lo declara, el subagente recibe SOLO el marco de
    // la tarea (ticket/repo) + las variables autorizadas. Si no, recibe el contexto completo (M3b).
    const subCtx: ExecutionContext = st.handoff
      ? await this.handoff.toContext({
          fromAgentId: 'orchestrator',
          toAgentId: agent.id,
          task: st.task,
          context: baseCtx,
          includeVariableKeys: st.handoff.variableKeys,
          workspaceId,
        })
      : { ...baseCtx, variables: { ...baseCtx.variables, task: st.task } };

    const policy = this.policyFor(st, defaultPolicy);
    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      try {
        // El tenant viaja hasta el subagente: sin él, un agente con memoria configurada correría SIN ella
        // (falla cerrado) solo por ejecutarse a través del coordinador.
        const r = await this.runtime.invoke(agent, subCtx, workspaceId);
        const output = String(r.output ?? '');
        emit({ type: 'subtask.succeeded', subtaskId: st.id, output: output.slice(0, 120) });
        return { subtaskId: st.id, output, context: r.context, tokens: r.tokens, cost: r.cost };
      } catch (e) {
        lastError = e;
        if (attempt < policy.maxAttempts && policy.backoffMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, policy.backoffMs * attempt));
        }
      }
    }
    emit({ type: 'subtask.failed', subtaskId: st.id, error: lastError instanceof Error ? lastError.message : String(lastError) });
    throw lastError;
  }

  private resolveAgent(st: Subtask, agents: Map<string, Agent>): Promise<Agent | null> {
    if (this.config.selectionStrategy) return this.config.selectionStrategy.selectAgent(st, agents);
    return Promise.resolve(agents.get(st.agentId) ?? null);
  }
}
