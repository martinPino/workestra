import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType, ExecutionContext } from '@core/contracts';

/**
 * Primeros executors REALES como plugins (Strategy): Condición y HTTP.
 * Se registran en el NodeExecutorRegistry sin tocar el runner (Open/Closed).
 */

function getPath(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), root);
}

/**
 * Evaluador SEGURO (sin eval). Soporta VARIAS cláusulas `path <op> literal` unidas por `&&` (Y) o `||` (O)
 * — el constructor de reglas visual (M21) compila a esta forma. Un solo tipo de combinador por expresión.
 * Fallback: expr === 'true'.
 */
export function evalCondition(expr: string, ctx: ExecutionContext): boolean {
  const trimmed = expr.trim();
  if (trimmed === '') return false;
  if (trimmed.includes('||')) return trimmed.split('||').some((c) => evalClause(c, ctx));
  if (trimmed.includes('&&')) return trimmed.split('&&').every((c) => evalClause(c, ctx));
  return evalClause(trimmed, ctx);
}

/** Una sola cláusula `path <op> literal`. `~` = «contiene» (subcadena, case-insensitive). */
function evalClause(expr: string, ctx: ExecutionContext): boolean {
  const m = expr.match(/^\s*([\w.]+)\s*(==|!=|>=|<=|>|<|~)\s*(.+?)\s*$/);
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
    case '~':
      return String(left ?? '').toLowerCase().includes(String(right).toLowerCase());
    default:
      return false;
  }
}

export class ConditionNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'condition';
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const result = evalCondition(String(ctx.config.expression ?? 'true'), ctx.context);
    const handle = result ? 'true' : 'false';
    const variables = {
      ...ctx.context.variables,
      [`condition:${ctx.nodeKey}`]: result,
      // M14: persiste la decisión de flujo para que el runner PODE la rama NO tomada. Solo poda las
      // aristas etiquetadas con el otro handle; una arista sin `sourceHandle` fluye siempre.
      [`flow:${ctx.nodeKey}`]: { handles: [handle] },
    };
    return { context: { ...ctx.context, variables }, control: { kind: 'branch', handle } };
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
