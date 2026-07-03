import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType, Agent } from '@core/contracts';
import type { IAgentRepository } from '@core/engine';
import { AgentRuntime } from './agent-runtime';
import { Orchestrator } from './orchestrator';

function inlineAgent(ctx: NodeExecutionContext): Agent {
  const c = ctx.config;
  return {
    id: 'inline',
    name: (c.name as string) ?? 'LLM',
    description: null,
    systemPrompt: (c.prompt as string) ?? 'Eres un asistente útil.',
    model: (c.model as string) ?? 'mock-1',
    tools: [],
    memoryScope: null,
    variables: null,
    limits: null,
    permissions: null,
    isOrchestrator: false,
  };
}

/**
 * Nodo Agente/LLM. Resuelve el agente por `config.agentId` desde el registro; si no hay id,
 * construye un agente efímero desde la config (nodo LLM inline). Devuelve `usage` (tokens/coste).
 */
export class AgentNodeExecutor implements INodeExecutor {
  readonly type: NodeType;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly agents: IAgentRepository,
    type: NodeType = 'agent',
    private readonly orchestrator?: Orchestrator,
  ) {
    this.type = type;
  }

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const agentId = String(ctx.config.agentId ?? '');
    // Aislamiento por tenant (M8): el agente referido debe pertenecer al workspace de la ejecución;
    // si no (o no hay id), se usa un agente efímero inline — nunca un agente de otro tenant.
    const agent: Agent = (agentId ? await this.agents.getInWorkspace(agentId, ctx.workspaceId) : null) ?? inlineAgent(ctx);

    // El Orchestrator es "un agente cuyo output es un Plan": mismo nodo, comportamiento por flag.
    const result =
      agent.isOrchestrator && this.orchestrator
        ? await this.orchestrator.run(agent, ctx.context, ctx.emit, ctx.workspaceId)
        : await this.runtime.invoke(agent, ctx.context);

    return {
      context: result.context,
      control: { kind: 'continue' },
      usage: { tokens: result.tokens, cost: result.cost },
    };
  }
}
