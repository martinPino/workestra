import type { ExecutionEvent, ExecutionStatus } from '@core/contracts';

/**
 * ExecutionStateReducer: proyección PURA y determinista del stream de `ExecutionEvent`
 * al estado de una ejecución. Compartido cliente/servidor: el gateway WS solo REENVÍA
 * eventos; tanto el editor (colores en vivo) como el servidor derivan el estado aplicando
 * este reducer. Sin efectos, sin `Date.now()`/random → apto para replay determinista.
 */

export type NodeRunStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'skipped';

export interface NodeRuntimeState {
  status: NodeRunStatus;
  stepKey?: string;
  error?: string;
}

export interface SubtaskState {
  agentId: string;
  task?: string;
  status: NodeRunStatus;
  output?: string;
}

/** Proyección del sub-DAG del Orchestrator (árbol de subtareas observable en vivo). */
export interface PlanState {
  nodeKey: string;
  planId: string;
  subtasks: Record<string, SubtaskState>;
  order: string[];
  edges: Array<{ source: string; target: string }>;
  merged?: string;
  validationErrors?: string[];
}

export interface ExecutionState {
  executionId?: string;
  status: ExecutionStatus | 'UNKNOWN';
  nodes: Record<string, NodeRuntimeState>;
  plan?: PlanState;
  lastSeq: number;
  error?: string;
}

export const initialExecutionState = (): ExecutionState => ({
  status: 'UNKNOWN',
  nodes: {},
  lastSeq: -1,
});

/** Aplica un evento al estado. Ignora eventos fuera de orden o duplicados (`seq <= lastSeq`). */
export function reduceExecutionEvent(state: ExecutionState, e: ExecutionEvent): ExecutionState {
  if (e.seq <= state.lastSeq) return state;

  const nodes: Record<string, NodeRuntimeState> = { ...state.nodes };
  let status = state.status;
  let error = state.error;
  let plan = state.plan;

  switch (e.type) {
    case 'execution.queued':
      status = 'QUEUED';
      break;
    case 'execution.started':
      status = 'RUNNING';
      break;
    case 'execution.status':
      status = e.status;
      break;
    case 'node.started':
      nodes[e.nodeKey] = { status: 'running', stepKey: e.stepKey };
      break;
    case 'node.succeeded':
      nodes[e.nodeKey] = { ...nodes[e.nodeKey], status: 'succeeded', stepKey: e.stepKey };
      break;
    case 'node.failed':
      nodes[e.nodeKey] = { ...nodes[e.nodeKey], status: 'failed', stepKey: e.stepKey, error: e.error };
      break;
    case 'node.skipped':
      nodes[e.nodeKey] = { ...nodes[e.nodeKey], status: 'skipped' };
      break;
    case 'execution.succeeded':
      status = 'SUCCEEDED';
      break;
    case 'execution.failed':
      status = 'FAILED';
      error = e.error;
      break;
    case 'plan.created': {
      const subtasks: Record<string, SubtaskState> = {};
      for (const s of e.subtasks) subtasks[s.id] = { agentId: s.agentId, task: s.task, status: 'pending' };
      plan = { nodeKey: e.nodeKey, planId: e.planId, subtasks, order: e.subtasks.map((s) => s.id), edges: e.edges };
      break;
    }
    case 'plan.validation_failed':
      plan = { ...(plan ?? { nodeKey: e.nodeKey, planId: '', subtasks: {}, order: [], edges: [] }), validationErrors: e.errors };
      break;
    case 'subtask.started':
      if (plan) plan = { ...plan, subtasks: { ...plan.subtasks, [e.subtaskId]: { ...plan.subtasks[e.subtaskId], status: 'running' } } };
      break;
    case 'subtask.succeeded':
      if (plan)
        plan = {
          ...plan,
          subtasks: { ...plan.subtasks, [e.subtaskId]: { ...plan.subtasks[e.subtaskId], status: 'succeeded', output: e.output } },
        };
      break;
    case 'subtask.failed':
      if (plan)
        plan = {
          ...plan,
          subtasks: { ...plan.subtasks, [e.subtaskId]: { ...plan.subtasks[e.subtaskId], status: 'failed' } },
        };
      break;
    case 'plan.execution_failed':
      error = e.error;
      break;
    case 'results.merged':
      if (plan) plan = { ...plan, merged: e.summary };
      break;
    case 'human.requested':
      // El nodo Humano queda en ESPERA (visible en el editor en vivo). La suspensión global la marca
      // 'execution.status' (WAITING_HUMAN); al reanudar, un nuevo 'node.started' lo pasa a 'running'.
      nodes[e.nodeKey] = { ...nodes[e.nodeKey], status: 'waiting' };
      break;
    case 'human.resolved':
      status = e.approved ? 'RUNNING' : 'FAILED';
      break;
  }

  return { ...state, executionId: e.executionId, status, nodes, plan, error, lastSeq: e.seq };
}

/** Pliega una lista completa de eventos al estado final (base del replay). */
export function reduceExecution(events: readonly ExecutionEvent[]): ExecutionState {
  let state = initialExecutionState();
  for (const e of events) state = reduceExecutionEvent(state, e);
  return state;
}
