import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType, Agent } from '@core/contracts';
import type { IAgentRepository } from '@core/engine';
import { AgentRuntime } from './agent-runtime';
import { Orchestrator } from './orchestrator';
import { interpolate } from './interpolate';

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

    // Entrada del agente (M12): si el nodo define `input`, se interpola y se pasa como tarea
    // (variables.task, que el runtime lee) SOLO para esta invocación. Permite "responde a: {{...}}".
    const input = ctx.config.input != null ? interpolate(String(ctx.config.input), ctx.context) : '';
    const context = input ? { ...ctx.context, variables: { ...ctx.context.variables, task: input } } : ctx.context;

    // El Orchestrator es "un agente cuyo output es un Plan": mismo nodo, comportamiento por flag.
    const result =
      agent.isOrchestrator && this.orchestrator
        ? await this.orchestrator.run(agent, context, ctx.emit, ctx.workspaceId)
        : await this.runtime.invoke(agent, context, ctx.workspaceId, {
            executionId: ctx.executionId,
            nodeKey: ctx.nodeKey,
            emit: ctx.emit, // M72: las tools (p. ej. navegador) emiten sus acciones al stream para el replay
          });

    // Saneamiento del contexto de salida (fixes revisión M13):
    // 1) El `task` derivado del `input` de ESTE nodo NO debe filtrarse aguas abajo: se restaura el
    //    task del contexto ENTRANTE (si no, un nodo Agente posterior sin `input` heredaría esta tarea
    //    en vez de caer a ticket.title). No hace nada si el nodo no tenía input.
    // 2) Alias ÚNICO de la salida por `nodeKey` (`agent:<nodeKey>`), además del alias por nombre, para
    //    que dos agentes con el MISMO nombre (p. ej. dos nodos LLM) no colisionen ni pierdan datos.
    const outVars = { ...(result.context.variables as Record<string, unknown>) };
    const incoming = ctx.context.variables as Record<string, unknown>;
    if ('task' in incoming) outVars.task = incoming.task;
    else delete outVars.task;
    const byName = outVars[`agent:${agent.name}`];
    if (byName !== undefined) outVars[`agent:${ctx.nodeKey}`] = byName;

    return {
      context: { ...result.context, variables: outVars },
      control: { kind: 'continue' },
      usage: { tokens: result.tokens, cost: result.cost },
    };
  }
}
