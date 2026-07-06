import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType, ExecutionContext } from '@core/contracts';
import { interpolate } from './interpolate';

/**
 * Primeros executors REALES como plugins (Strategy): Condición y HTTP.
 * Se registran en el NodeExecutorRegistry sin tocar el runner (Open/Closed).
 */

/** Parsea la respuesta a JSON para exponerla a nodos posteriores (`{{http:nodo.json.…}}`), solo si es
 *  pequeña (≤64 KB, no infla el contexto persistido) y es JSON válido. `undefined` en caso contrario. */
export function safeHttpJson(text: string): unknown {
  if (text.length > 64_000) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parsea el campo `headers` (objeto JSON, ya interpolado) a un mapa string→string apto para fetch.
 *  Tolera vacío/no-objeto devolviendo `{}` — nunca lanza, para no tumbar el nodo por un JSON mal escrito. */
export function parseHeaders(raw: string): Record<string, string> {
  const s = raw.trim();
  if (!s) return {};
  try {
    const obj = JSON.parse(s) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v != null) out[k] = typeof v === 'string' ? v : String(v);
    }
    return out;
  } catch {
    return {};
  }
}

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
  // 30 s por defecto: las APIs externas (generación de imágenes, LLMs) tardan más que un webhook interno.
  constructor(private readonly timeoutMs = 30_000) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    // URL, cabeceras y cuerpo admiten {{variables}}: así el nodo puede usar la salida de pasos previos
    // (p. ej. la API key de una cabecera, o `{{http:noticias.json.articles.0.title}}` en el cuerpo).
    const url = interpolate(String(ctx.config.url ?? ''), ctx.context);
    const method = String(ctx.config.method ?? 'GET').toUpperCase();

    const store = (result: Record<string, unknown>): NodeResult => ({
      context: { ...ctx.context, variables: { ...ctx.context.variables, [`http:${ctx.nodeKey}`]: result } },
      control: { kind: 'continue' },
    });
    if (!url) return store({ error: 'http: falta la URL en la config del nodo.' });

    const headers = parseHeaders(interpolate(String(ctx.config.headers ?? ''), ctx.context, true));
    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD' && ctx.config.body != null) {
      const raw = ctx.config.body;
      const bodyStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (bodyStr.trim()) {
        body = interpolate(bodyStr, ctx.context, true); // jsonSafe: escapa strings incrustados
        if (!('content-type' in headers) && !('Content-Type' in headers)) headers['content-type'] = 'application/json';
      }
    }

    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const res = await fetch(url, { method, headers, body, signal });
      const text = await res.text();
      const bodyPreview = text.slice(0, 4000);
      const json = safeHttpJson(text); // respuesta parseada para {{http:nodo.json.…}}
      return store({ status: res.status, ok: res.ok, bodyPreview, json });
    } catch (e) {
      return store({ error: e instanceof Error ? e.message : String(e) });
    }
  }
}
