import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType, ExecutionContext } from '@core/contracts';

/**
 * Primeros executors REALES como plugins (Strategy): Condición y HTTP.
 * Se registran en el NodeExecutorRegistry sin tocar el runner (Open/Closed).
 */

function getPath(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), root);
}

/** Evaluador SEGURO (sin eval): `path <op> literal`. Fallback: expr === 'true'. */
export function evalCondition(expr: string, ctx: ExecutionContext): boolean {
  const m = expr.match(/^\s*([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*$/);
  if (!m) return expr.trim() === 'true';
  const [, path, op, rawRight] = m;
  const left = getPath({ variables: ctx.variables, ticket: ctx.ticket, repository: ctx.repository }, path);
  let right: unknown = rawRight;
  if (/^-?\d+(\.\d+)?$/.test(rawRight)) right = Number(rawRight);
  else if (rawRight === 'true') right = true;
  else if (rawRight === 'false') right = false;
  else right = rawRight.replace(/^["']|["']$/g, '');
  switch (op) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    default:
      return false;
  }
}

export class ConditionNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'condition';
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const result = evalCondition(String(ctx.config.expression ?? 'true'), ctx.context);
    const variables = { ...ctx.context.variables, [`condition:${ctx.nodeKey}`]: result };
    // Nota: el PRUNING de la rama no tomada llega con el control de flujo del engine (M4/M9).
    return { context: { ...ctx.context, variables }, control: { kind: 'branch', handle: result ? 'true' : 'false' } };
  }
}

export class HttpNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'api';
  constructor(private readonly timeoutMs = 10_000) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const url = String(ctx.config.url ?? '');
    const method = String(ctx.config.method ?? 'GET');
    if (!url) return { context: ctx.context, control: { kind: 'continue' } };

    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]);
    let result: Record<string, unknown>;
    try {
      const res = await fetch(url, { method, signal });
      const bodyPreview = (await res.text()).slice(0, 500);
      result = { status: res.status, ok: res.ok, bodyPreview };
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) };
    }
    const variables = { ...ctx.context.variables, [`http:${ctx.nodeKey}`]: result };
    return { context: { ...ctx.context, variables }, control: { kind: 'continue' } };
  }
}
