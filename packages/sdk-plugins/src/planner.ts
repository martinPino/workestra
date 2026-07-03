import type { ModelRouter } from '@core/llm';
import type { Plan } from '@core/domain';

export interface AgentSummary {
  id: string;
  name: string;
  description?: string | null;
}

/** Genera un Plan (DAG de subtareas) a partir de una tarea y los agentes disponibles. */
export interface Planner {
  buildPlan(task: string, agents: AgentSummary[]): Promise<Plan>;
}

const PLANNER_SYSTEM =
  'Eres un planificador. Descompón la tarea en subtareas y asigna cada una a un agente disponible. ' +
  'Devuelve SOLO un JSON con la forma {"subtasks":[{"id","agentId","task"}],"edges":[{"source","target"}]}.';

let planCounter = 0;

/** Planner respaldado por LLM con salida estructurada (responseFormat=json). */
export class LlmPlanner implements Planner {
  constructor(
    private readonly router: ModelRouter,
    private readonly model = 'mock-1',
  ) {}

  async buildPlan(task: string, agents: AgentSummary[]): Promise<Plan> {
    const res = await this.router.chat({
      model: this.model,
      responseFormat: 'json',
      messages: [
        { role: 'system', content: PLANNER_SYSTEM },
        {
          role: 'user',
          content:
            `TAREA: ${task}\n` +
            `AGENTES DISPONIBLES: ${agents.map((a) => `${a.id}=${a.name}`).join('; ')}\n` +
            `<<PLAN_AGENTS:${agents.map((a) => a.id).join(',')}>>\n` +
            `<<PLAN_TASK:${task}>>`,
        },
      ],
    });

    let parsed: { subtasks?: Plan['subtasks']; edges?: Plan['edges'] };
    try {
      parsed = JSON.parse(res.content);
    } catch {
      throw new Error('El LLM no devolvió un JSON de plan válido.');
    }
    return { id: `plan_${++planCounter}`, subtasks: parsed.subtasks ?? [], edges: parsed.edges ?? [] };
  }
}
