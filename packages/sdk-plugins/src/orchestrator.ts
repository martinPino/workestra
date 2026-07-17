import type { Agent, ExecutionContext, AgentResult } from '@core/contracts';
import type { IAgentRepository } from '@core/engine';
import { validatePlan, type Plan, type PlanExecutor, type PlanBudget } from '@core/domain';
import { AgentRuntime } from './agent-runtime';
import { DefaultPlanExecutor } from './plan-executor-impl';
import { CapabilitySelectionStrategy } from './capability-selection';
import type { Planner, AgentSummary } from './planner';

export interface OrchestratorDeps {
  planner: Planner;
  agents: IAgentRepository;
  runtime: AgentRuntime;
  maxRepairs?: number;
  /** PlanExecutor a usar (por defecto DefaultPlanExecutor durable + selección por capacidades). */
  planExecutor?: PlanExecutor;
  /** Presupuesto global del plan; si no se da, se deriva de `agent.limits` del Orchestrator. */
  budget?: PlanBudget;
}

/** Deriva un presupuesto de plan desde los límites del agente Orchestrator (si los declara). */
function budgetFromLimits(limits: Agent['limits']): PlanBudget | undefined {
  const l = limits as { maxTokens?: number; maxCost?: number } | null;
  if (!l) return undefined;
  const budget: PlanBudget = {};
  if (typeof l.maxTokens === 'number') budget.maxTokens = l.maxTokens;
  if (typeof l.maxCost === 'number') budget.maxCost = l.maxCost;
  return budget.maxTokens != null || budget.maxCost != null ? budget : undefined;
}

function taskFrom(ctx: ExecutionContext): string {
  const vars = ctx.variables as Record<string, unknown>;
  const ticket = ctx.ticket as Record<string, unknown>;
  return String(vars.task ?? ticket.title ?? 'Coordina el trabajo con los agentes disponibles.');
}

/**
 * Orchestrator (agente líder): analiza la tarea, planifica (LLM estructurado), VALIDA el Plan
 * (re-prompt acotado si es inválido), materializa el sub-DAG y despacha cada subtarea a un agente
 * real, y fusiona los resultados. Solo coordina: no ejecuta trabajo técnico. Emite eventos de plan
 * y subtareas para que el árbol sea observable en vivo.
 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async run(
    agent: Agent,
    ctx: ExecutionContext,
    emit: (e: unknown) => void,
    workspaceId: string,
  ): Promise<AgentResult> {
    const task = taskFrom(ctx);
    const available = (await this.deps.agents.list(workspaceId)).filter((a) => !a.isOrchestrator);
    const summaries: AgentSummary[] = available.map((a) => ({ id: a.id, name: a.name, description: a.description }));
    const agentIds = summaries.map((s) => s.id);

    // 1) Planificar + validar con re-prompt acotado (de-riesga planes inválidos).
    let plan: Plan | null = null;
    let lastErrors: string[] = [];
    const maxRepairs = this.deps.maxRepairs ?? 2;
    let tokens = 0;
    let cost = 0;

    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const candidate = await this.deps.planner.buildPlan(task, summaries);
      const validation = validatePlan(candidate, agentIds);
      if (validation.valid) {
        plan = candidate;
        break;
      }
      lastErrors = validation.errors.map((e) => e.message);
      emit({ type: 'plan.validation_failed', errors: lastErrors });
    }
    if (!plan) {
      throw new Error(`No se pudo generar un Plan válido tras ${maxRepairs + 1} intentos: ${lastErrors.join('; ')}`);
    }
    emit({ type: 'plan.created', planId: plan.id, subtasks: plan.subtasks, edges: plan.edges });

    // 2) Materializar y ejecutar el sub-DAG vía PlanExecutor (durable/paralelo por defecto), con
    //    readiness por dependencias, política por subtarea, selección por capacidades y presupuesto.
    const executor =
      this.deps.planExecutor ??
      new DefaultPlanExecutor(this.deps.runtime, {
        mode: 'durable',
        selectionStrategy: new CapabilitySelectionStrategy(),
        budget: this.deps.budget ?? budgetFromLimits(agent.limits),
      });
    const agentMap = new Map(available.map((a) => [a.id, a]));
    const planResult = await executor.execute(plan, ctx, agentMap, emit, workspaceId);
    tokens += planResult.totalTokens;
    cost += planResult.totalCost;

    // 3) Fusionar resultados.
    const summary = `Orchestrator: ${Object.keys(planResult.results).length} subtareas completadas y fusionadas.`;
    emit({ type: 'results.merged', summary });

    const context: ExecutionContext = {
      ...planResult.context,
      variables: {
        ...planResult.context.variables,
        [`orchestrator:${agent.name}`]: { plan: plan.id, subtasks: planResult.results, merged: summary },
      },
    };
    return { context, output: summary, tokens, cost };
  }
}
