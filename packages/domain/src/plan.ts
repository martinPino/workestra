import type { WorkflowGraph } from '@core/contracts';
import { validateDag } from './dag';

/** Plan del Orchestrator: un DAG de subtareas, cada una asignada a un agente. */
export interface Subtask {
  id: string;
  agentId: string;
  task: string;
  /** Capacidades/tools requeridas por la subtarea (para la selección por capacidades). */
  requires?: string[];
  /** Política de reintentos POR subtarea (override del default del executor). */
  policy?: { maxAttempts?: number; backoffMs?: number };
  /** Rebanado de contexto (mínimo privilegio): variables a propagar al subagente vía HandoffService. */
  handoff?: { variableKeys?: string[] };
}
export interface PlanEdge {
  source: string;
  target: string;
}
export interface Plan {
  id: string;
  subtasks: Subtask[];
  edges: PlanEdge[];
}

export interface PlanValidationError {
  code: 'EMPTY_PLAN' | 'DUPLICATE_SUBTASK' | 'DANGLING_EDGE' | 'CYCLE' | 'UNKNOWN_AGENT';
  message: string;
}
export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationError[];
}

/**
 * Valida el Plan (el riesgo #1 del Orchestrator): DAG bien formado (sin ciclos ni aristas
 * colgantes ni ids duplicados) y con todos los agentes referenciados existentes.
 */
export function validatePlan(plan: Plan, availableAgentIds: string[]): PlanValidationResult {
  const errors: PlanValidationError[] = [];

  if (plan.subtasks.length === 0) {
    errors.push({ code: 'EMPTY_PLAN', message: 'El plan no tiene subtareas.' });
  }

  const agents = new Set(availableAgentIds);
  for (const st of plan.subtasks) {
    if (!agents.has(st.agentId)) {
      errors.push({ code: 'UNKNOWN_AGENT', message: `La subtarea "${st.id}" referencia un agente inexistente: ${st.agentId}` });
    }
  }

  const graph: WorkflowGraph = {
    nodes: plan.subtasks.map((s) => ({ key: s.id, type: 'agent', config: {}, position: { x: 0, y: 0 } })),
    edges: plan.edges.map((e) => ({ source: e.source, target: e.target })),
  };
  for (const e of validateDag(graph).errors) {
    if (e.code === 'CYCLE') errors.push({ code: 'CYCLE', message: 'El plan contiene un ciclo (no es un DAG).' });
    else if (e.code === 'EDGE_SOURCE_MISSING' || e.code === 'EDGE_TARGET_MISSING')
      errors.push({ code: 'DANGLING_EDGE', message: e.message });
    else if (e.code === 'DUPLICATE_NODE_KEY') errors.push({ code: 'DUPLICATE_SUBTASK', message: e.message });
  }

  return { valid: errors.length === 0, errors };
}
