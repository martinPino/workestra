import type {
  Agent,
  ExecutionContext,
  IAgentRuntime,
  AgentResult,
  LlmMessage,
  LlmToolDef,
  Role,
} from '@core/contracts';
import type { IMemoryStore } from '@core/engine';
import { type ModelRouter, CostCalculator } from '@core/llm';
import { ToolRegistry } from './tools';
import { ToolAuthorizationService } from './tool-authorization';

export interface AgentRuntimeDeps {
  router: ModelRouter;
  tools: ToolRegistry;
  authz: ToolAuthorizationService;
  cost?: CostCalculator;
  memory?: IMemoryStore;
  maxIterations?: number;
}

function roleOf(agent: Agent): Role {
  const r = (agent.permissions as { role?: string } | null)?.role;
  return r === 'OWNER' || r === 'ADMIN' || r === 'EDITOR' || r === 'VIEWER' ? r : 'EDITOR';
}

function buildTask(ctx: ExecutionContext): string {
  const vars = ctx.variables as Record<string, unknown>;
  const ticket = ctx.ticket as Record<string, unknown>;
  return String(vars.task ?? ticket.title ?? 'Realiza tu tarea con el contexto disponible.');
}

/**
 * Prompt de sistema EFECTIVO: define un Rol/persona (M13). Si el agente tiene un objetivo
 * (`description`), se antepone «Actúas como «{nombre}». Tu objetivo: …» al `systemPrompt`, de modo
 * que la persona guíe el comportamiento. El nodo LLM inline (sin `description`) usa su prompt tal cual.
 */
function composeSystemPrompt(agent: Agent): string {
  if (!agent.description) return agent.systemPrompt;
  return `Actúas como «${agent.name}». Tu objetivo: ${agent.description}.\n\n${agent.systemPrompt}`;
}

/**
 * Runtime del agente: bucle de tool-calling AUTORIZADO (deny-by-default vía RBAC), guardrails
 * mínimos (límite de iteraciones) y acceso a memoria compartida. El proveedor LLM es intercambiable
 * por config a través del ModelRouter (el runtime no conoce proveedores concretos).
 */
export class AgentRuntime implements IAgentRuntime {
  private readonly cost: CostCalculator;
  private readonly maxIterations: number;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.cost = deps.cost ?? new CostCalculator();
    this.maxIterations = deps.maxIterations ?? 4;
  }

  async invoke(agent: Agent, ctx: ExecutionContext): Promise<AgentResult> {
    const role = roleOf(agent);
    const toolDefs: LlmToolDef[] = agent.tools
      .filter((t) => this.deps.tools.get(t))
      .map((t) => ({ name: t, description: `Tool ${t}`, parameters: {} }));

    const messages: LlmMessage[] = [
      { role: 'system', content: composeSystemPrompt(agent) },
      { role: 'user', content: buildTask(ctx) },
    ];

    if (this.deps.memory) {
      const prior = await this.deps.memory.get('shared', agent.id, 'notes');
      if (prior !== undefined) {
        messages.splice(1, 0, { role: 'system', content: `Memoria previa: ${JSON.stringify(prior).slice(0, 400)}` });
      }
    }

    let tokens = 0;
    let cost = 0;
    let finalText = '';
    const toolLog: Array<{ tool: string; allowed: boolean; result: unknown }> = [];

    for (let i = 0; i < this.maxIterations; i++) {
      const res = await this.deps.router.chat({
        model: agent.model,
        messages,
        tools: toolDefs.length ? toolDefs : undefined,
      });
      tokens += res.usage.inputTokens + res.usage.outputTokens;
      cost += this.cost.cost(agent.model, res.usage).total;

      if (res.toolCalls.length === 0) {
        finalText = res.content;
        break;
      }

      for (const call of res.toolCalls) {
        const authz = this.deps.authz.authorize({ role, agentTools: agent.tools, toolKey: call.name });
        let result: unknown;
        if (!authz.allowed) {
          result = { error: 'tool no autorizada', reason: authz.reason };
        } else {
          const tool = this.deps.tools.get(call.name);
          result = tool ? await tool.invoke(call.arguments, {}) : { error: 'tool inexistente' };
        }
        toolLog.push({ tool: call.name, allowed: authz.allowed, result });
        messages.push({ role: 'assistant', content: `tool_call:${call.name}` });
        messages.push({ role: 'tool', name: call.name, content: JSON.stringify(result).slice(0, 500), toolCallId: call.id });
      }
    }

    if (this.deps.memory && finalText) {
      await this.deps.memory.append('shared', agent.id, 'notes', finalText.slice(0, 200));
    }

    const context: ExecutionContext = {
      ...ctx,
      variables: { ...ctx.variables, [`agent:${agent.name}`]: { output: finalText, tools: toolLog } },
    };
    return { context, output: finalText, tokens, cost };
  }
}
