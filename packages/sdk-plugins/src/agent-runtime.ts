import type {
  Agent,
  ExecutionContext,
  IAgentRuntime,
  AgentResult,
  LlmMessage,
  LlmToolDef,
  Role,
} from '@core/contracts';
import type { IMemoryStore, IMcpToolResolver, McpTool } from '@core/engine';
import { type ModelRouter, CostCalculator } from '@core/llm';
import { ToolRegistry } from './tools';
import { ToolAuthorizationService } from './tool-authorization';

export interface AgentRuntimeDeps {
  router: ModelRouter;
  tools: ToolRegistry;
  authz: ToolAuthorizationService;
  cost?: CostCalculator;
  memory?: IMemoryStore;
  mcp?: IMcpToolResolver; // M40: expande los servidores MCP del agente en herramientas invocables
  maxIterations?: number;
}

/**
 * Contexto de ejecución que el runtime pasa a las TOOLS (M72): id de ejecución, nodo y un `emit` para
 * publicar eventos en el stream (p. ej. las acciones del navegador se ven paso a paso en el replay).
 */
export interface AgentExecMeta {
  executionId?: string;
  nodeKey?: string;
  emit?: (event: unknown) => void;
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

  async invoke(agent: Agent, ctx: ExecutionContext, workspaceId?: string, exec?: AgentExecMeta): Promise<AgentResult> {
    const role = roleOf(agent);
    // M40: expande los servidores MCP enganchados al agente en herramientas reales (nombre + esquema). Un
    // servidor caído devuelve [] (no rompe). Se ofrecen al modelo junto a las tools internas del agente.
    const mcpTools: McpTool[] =
      this.deps.mcp && workspaceId && agent.mcpServers?.length
        ? await this.deps.mcp.resolve(workspaceId, agent.mcpServers).catch(() => [])
        : [];
    const mcpByName = new Map(mcpTools.map((tt) => [tt.name, tt]));
    // Tools internas: usan su `describe()` (descripción + esquema de parámetros para el LLM) si lo aportan
    // (p. ej. «browser», con muchas acciones); si no, un genérico. Así el modelo sabe cómo llamarlas.
    const builtinDefs: LlmToolDef[] = agent.tools
      .map((t) => ({ key: t, tool: this.deps.tools.get(t) }))
      .filter((x): x is { key: string; tool: NonNullable<typeof x.tool> } => !!x.tool)
      .map((x) => {
        const d = x.tool.describe?.();
        return { name: x.key, description: d?.description ?? `Tool ${x.key}`, parameters: d?.parameters ?? {} };
      });
    const toolDefs: LlmToolDef[] = [
      ...builtinDefs,
      ...mcpTools.map((tt) => ({ name: tt.name, description: tt.description, parameters: tt.parameters })),
    ];

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
        let result: unknown;
        let allowed = true;
        const mcpTool = mcpByName.get(call.name);
        if (mcpTool) {
          // Herramienta de un servidor MCP enganchado al agente: autorizada por estar enganchada (el
          // servidor lo añadió el workspace). Un fallo de red devuelve un error legible, no rompe el bucle.
          try {
            result = await mcpTool.invoke(call.arguments);
          } catch (e) {
            result = { error: 'fallo del servidor MCP', reason: e instanceof Error ? e.message : String(e) };
          }
        } else {
          const authz = this.deps.authz.authorize({ role, agentTools: agent.tools, toolKey: call.name });
          allowed = authz.allowed;
          if (!authz.allowed) {
            result = { error: 'tool no autorizada', reason: authz.reason };
          } else {
            const tool = this.deps.tools.get(call.name);
            // Pasa el contexto de ejecución a la tool (M72): workspace (persistir artefactos), execución/nodo
            // y `emit` (publicar eventos en el stream, p. ej. acciones del navegador para el replay).
            const auth = { workspaceId, executionId: exec?.executionId, nodeKey: exec?.nodeKey, emit: exec?.emit };
            result = tool ? await tool.invoke(call.arguments, auth) : { error: 'tool inexistente' };
          }
        }
        toolLog.push({ tool: call.name, allowed, result });
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
