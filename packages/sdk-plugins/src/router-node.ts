import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType } from '@core/contracts';
import type { IAgentRepository } from '@core/engine';
import type { ModelRouter } from '@core/llm';
import { interpolate } from './interpolate';

function taskOf(ctx: NodeExecutionContext): string {
  if (ctx.config.input != null) {
    const s = interpolate(String(ctx.config.input), ctx.context);
    if (s.trim()) return s;
  }
  const vars = ctx.context.variables as Record<string, unknown>;
  const ticket = ctx.context.ticket as Record<string, unknown> | undefined;
  return String(vars.task ?? ticket?.title ?? 'Decide qué agente debe encargarse.');
}

/**
 * Nodo ROUTER / Coordinador (M14): ELIGE a cuál(es) de los nodos de agente conectados enrutar la
 * tarea. Lee sus aristas salientes (`ctx.outgoing`), resuelve los agentes destino (nombre + objetivo),
 * pide al LLM del coordinador que elija el/los adecuado(s), y escribe la decisión en `flow:<nodeKey>`
 * para que el runner active SOLO esas aristas (los agentes NO elegidos se saltan). Las aristas a nodos
 * que NO son agente (p. ej. Fin) quedan siempre activas. Fail-open: ante cualquier fallo o con el
 * modelo mock (que no razona), activa TODOS los agentes (se comporta como un fan-out).
 */
export class RouterNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'router';

  constructor(
    private readonly agents: IAgentRepository,
    private readonly router: ModelRouter,
  ) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const outgoing = ctx.outgoing ?? [];
    const agentEdges = outgoing.filter((e) => e.targetType === 'agent');
    const nonAgentTargets = outgoing.filter((e) => e.targetType !== 'agent').map((e) => e.target);

    // Candidatos: agentes destino resueltos por tenant (su nombre + objetivo guían la decisión).
    const candidates: Array<{ target: string; name: string; objetivo: string }> = [];
    for (const e of agentEdges) {
      const agentId = String((e.targetConfig as Record<string, unknown>)?.agentId ?? '');
      const agent = agentId ? await this.agents.getInWorkspace(agentId, ctx.workspaceId) : null;
      candidates.push({ target: e.target, name: agent?.name ?? e.target, objetivo: agent?.description ?? '' });
    }

    const store = (agentTargets: string[], decision: unknown, usage?: { tokens: number; cost: number }): NodeResult => ({
      context: {
        ...ctx.context,
        variables: {
          ...ctx.context.variables,
          // Aristas activas = destinos no-agente (siempre) + agentes elegidos.
          [`flow:${ctx.nodeKey}`]: { targets: [...new Set([...nonAgentTargets, ...agentTargets])] },
          [`router:${ctx.nodeKey}`]: decision,
        },
      },
      control: { kind: 'continue' },
      usage,
    });

    // Sin agentes destino: nada que elegir → activa todo (comportamiento normal, no poda).
    if (candidates.length === 0) return { context: ctx.context, control: { kind: 'continue' } };

    const task = taskOf(ctx);
    // Modelo de la decisión: el del agente coordinador (config.agentId), o config.model, o mock.
    const coordId = String(ctx.config.agentId ?? '');
    const coord = coordId ? await this.agents.getInWorkspace(coordId, ctx.workspaceId) : null;
    const model = coord?.model ?? String(ctx.config.model ?? 'mock-1');

    let chosen: string[] = [];
    let usage = { tokens: 0, cost: 0 };
    try {
      const res = await this.router.chat({
        model,
        responseFormat: 'json',
        messages: [
          {
            role: 'system',
            content:
              'Eres un coordinador que asigna trabajo. Elige qué agente(s) deben encargarse de la tarea según su objetivo. Responde SOLO JSON: {"targets":["<key>", ...]} usando EXACTAMENTE las claves («key=...») dadas. Elige el mínimo necesario.',
          },
          {
            role: 'user',
            content: `Tarea: ${task}\n\nAgentes disponibles:\n${candidates.map((c) => `- key=${c.target} · ${c.name}: ${c.objetivo}`).join('\n')}`,
          },
        ],
      });
      usage = { tokens: res.usage.inputTokens + res.usage.outputTokens, cost: 0 };
      // Robustez: quita fences ```json y acepta que el LLM devuelva CLAVES o NOMBRES de agente.
      let content = (res.content || '{}').trim();
      const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) content = fence[1].trim();
      const parsed = JSON.parse(content) as { targets?: unknown };
      const raw = Array.isArray(parsed.targets) ? parsed.targets.map((x) => String(x)) : [];
      const norm = (s: string): string => s.trim().toLowerCase();
      chosen = raw
        .map((k) => candidates.find((c) => c.target === k)?.target ?? candidates.find((c) => norm(c.name) === norm(k))?.target)
        .filter((t): t is string => Boolean(t));
    } catch {
      /* fail-open: se activan todos abajo */
    }
    if (chosen.length === 0) chosen = candidates.map((c) => c.target); // fail-open → fan-out

    return store(chosen, { chosen, candidates: candidates.map((c) => ({ key: c.target, name: c.name })) }, usage);
  }
}
