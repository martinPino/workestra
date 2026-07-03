import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType } from '@core/contracts';
import { NodeExecutorRegistry } from './registry';

/** Ejecutor que no modifica el contexto y continúa. Base para nodos triviales de M0/M1. */
class PassthroughExecutor implements INodeExecutor {
  constructor(readonly type: NodeType) {}
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    return { context: ctx.context, control: { kind: 'continue' } };
  }
}

export class TriggerExecutor extends PassthroughExecutor {
  constructor() {
    super('trigger');
  }
}

export class EndExecutor implements INodeExecutor {
  readonly type: NodeType = 'end';
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    return { context: ctx.context, control: { kind: 'end' } };
  }
}

/** Nodo Espera: pausa `config.ms` (acotado). La durabilidad tras reinicio llega con TimerService. */
export class WaitNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'wait';
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const ms = Number((ctx.config as { ms?: number }).ms ?? 0);
    if (ms > 0) await new Promise((r) => setTimeout(r, Math.min(ms, 30_000)));
    return { context: ctx.context, control: { kind: 'continue' } };
  }
}

/** Nodo de trabajo pass-through (tipo configurable) que anota el contexto; delay opcional visible. */
export class WorkNodeExecutor implements INodeExecutor {
  constructor(
    readonly type: NodeType,
    private readonly stepDelayMs = 0,
  ) {}
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    if (this.stepDelayMs > 0) await new Promise((r) => setTimeout(r, this.stepDelayMs));
    const variables = { ...ctx.context.variables, [`${this.type}:${ctx.nodeKey}`]: 'ok' };
    return { context: { ...ctx.context, variables }, control: { kind: 'continue' } };
  }
}

/** Registro por defecto con los nodos de control mínimos. El resto llega por plugin. */
export function createDefaultNodeRegistry(): NodeExecutorRegistry {
  return new NodeExecutorRegistry().register(new TriggerExecutor()).register(new EndExecutor());
}
