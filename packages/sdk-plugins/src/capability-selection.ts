import type { Agent } from '@core/contracts';
import type { AgentSelectionStrategy, Subtask } from '@core/domain';

/**
 * Selección de agente POR CAPACIDADES (M5-B). Las capacidades de un agente son sus `tools`; una
 * subtarea puede exigir capacidades con `requires`. Preferimos el agente PEDIDO por el plan si cumple
 * los requisitos; si no, elegimos de forma DETERMINISTA (orden por id) el primero que los cubra. Sin
 * `requires`, respeta la asignación del plan. Así el sub-DAG tolera que el planner pida un agente
 * subóptimo: la ejecución lo redirige a uno capaz sin fallar.
 */
export class CapabilitySelectionStrategy implements AgentSelectionStrategy {
  async selectAgent(subtask: Subtask, agents: Map<string, Agent>): Promise<Agent | null> {
    const requires = subtask.requires ?? [];
    const covers = (a: Agent): boolean => requires.every((r) => a.tools.includes(r));

    const requested = agents.get(subtask.agentId) ?? null;
    if (requested && covers(requested)) return requested; // el pedido cumple → respétalo

    const capable = [...agents.values()].filter(covers).sort((a, b) => a.id.localeCompare(b.id));
    return capable[0] ?? requested; // primero capaz (determinista); si ninguno, el pedido (o null)
  }
}
