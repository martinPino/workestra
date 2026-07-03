// Re-exports EXPLÍCITOS (no `export *`): así el barrel CommonJS expone los nombres de forma
// estática y los bundlers (Rollup/Vite) los detectan cuando el frontend importa el reducer.

export { validateDag, topologicalLevels, hasCycle } from './dag';
export type { DagValidationError, DagValidationResult } from './dag';

export { buildExecutionPlan } from './execution-plan';
export type { ExecutionPlan } from './execution-plan';

export { createScheduler } from './scheduler';
export type { DagScheduler } from './scheduler';

export { reduceExecution, reduceExecutionEvent, initialExecutionState } from './execution-state';
export type { NodeRunStatus, NodeRuntimeState, ExecutionState, SubtaskState, PlanState } from './execution-state';

export { validatePlan } from './plan';
export type { Plan, Subtask, PlanEdge, PlanValidationError, PlanValidationResult } from './plan';

export { mergeContexts } from './merge';
export type { ContextContribution } from './merge';

export { flowDecisionOf, edgeIsLive, shouldRunNode } from './flow';
export type { FlowDecision } from './flow';

export type {
  PlanExecutor,
  PlanExecutorConfig,
  PlanExecutionResult,
  AgentSelectionStrategy,
  SubtaskPolicy,
  PlanBudget,
} from './plan-executor';
