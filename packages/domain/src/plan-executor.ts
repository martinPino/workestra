import type { Agent, ExecutionContext } from '@core/contracts';
import type { Plan, Subtask } from './plan';

/** Estrategia PLUGGABLE de selección de agente para una subtarea (capabilities/tags/coste/permisos). */
export interface AgentSelectionStrategy {
  selectAgent(subtask: Subtask, agents: Map<string, Agent>): Promise<Agent | null>;
}

export interface SubtaskPolicy {
  maxAttempts: number;
  backoffMs: number;
}

/** Presupuesto GLOBAL del plan. Si al terminar un nivel se excede, el plan se aborta (no se sigue gastando). */
export interface PlanBudget {
  maxTokens?: number;
  maxCost?: number;
}

export interface PlanExecutorConfig {
  /** `sequential` (una a una, M3b) o `durable` (paralelo por readiness, M5). Mismo contrato. */
  mode: 'sequential' | 'durable';
  selectionStrategy?: AgentSelectionStrategy;
  /** Política de reintentos por defecto (cada subtarea puede sobreescribirla con `subtask.policy`). */
  subtaskPolicy?: SubtaskPolicy;
  /** Tope global de tokens/coste; al excederse el plan falla con `plan.execution_failed`. */
  budget?: PlanBudget;
}

export interface PlanExecutionResult {
  context: ExecutionContext;
  results: Record<string, string>;
  totalTokens: number;
  totalCost: number;
}

/**
 * Materializa y ejecuta el sub-DAG de un `Plan`. El contrato es estable; solo cambia la política
 * de despacho (secuencial vs paralelo/durable). Emite los eventos de plan/subtarea (`emit`).
 */
export interface PlanExecutor {
  execute(
    plan: Plan,
    initialContext: ExecutionContext,
    agents: Map<string, Agent>,
    emit: (event: unknown) => void,
    /** Tenant de la ejecución (M81). Sin él, los subagentes corren SIN memoria: no se puede aislar por tenant. */
    workspaceId?: string,
  ): Promise<PlanExecutionResult>;
}
