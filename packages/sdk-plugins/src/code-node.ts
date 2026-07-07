import { Worker } from 'node:worker_threads';
import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType } from '@core/contracts';

/**
 * Nodo «Transformar datos» (M46): ejecuta un pequeño script JS para dar forma a los datos entre pasos —
 * construir una consulta, mapear/filtrar una lista, armar un cuerpo de petición (los pasos «Code» de n8n).
 * El script recibe `input` (la salida de los pasos previos) y hace `return <valor>`; el resultado queda en
 * `{{code:NodeKey.output}}` para los nodos siguientes.
 *
 * SEGURIDAD: el script corre en un WORKER aislado con `env: {}` (sin acceso a los secretos del proceso: claves
 * LLM, URL de BD…), con LÍMITE DE MEMORIA y TIMEOUT (se termina el worker), y dentro de un contexto V8 nuevo
 * SIN process/require/fetch/red/ficheros. `input` se reconstruye DENTRO del contexto (no se pasa un objeto del
 * host) para no dejar una referencia explotable a los internos de Node.
 */

// El código del worker se pasa como cadena (eval:true) → no necesita un fichero aparte tras compilar.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
try {
  const src = '"use strict"; const input = ' + workerData.inputLiteral + '; (function(){ ' + workerData.code + '\\n})();';
  const out = vm.runInNewContext(src, Object.create(null), { timeout: workerData.timeoutMs });
  parentPort.postMessage({ ok: true, out: out === undefined ? null : out });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
}
`;

export class CodeNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'code';
  constructor(private readonly timeoutMs = 1500) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const code = String(ctx.config.code ?? '').trim();
    const store = (result: Record<string, unknown>): NodeResult => ({
      context: { ...ctx.context, variables: { ...ctx.context.variables, [`code:${ctx.nodeKey}`]: result } },
      control: { kind: 'continue' },
    });
    if (!code) return store({ error: 'code: falta el script en la config del nodo.' });

    // Snapshot JSON del contexto → se embebe como literal para reconstruir `input` dentro del contexto V8.
    let inputLiteral: string;
    try {
      inputLiteral = JSON.stringify({
        ...(ctx.context.variables as Record<string, unknown>),
        ticket: ctx.context.ticket,
        repository: ctx.context.repository,
      });
      if (!inputLiteral || inputLiteral === 'undefined') inputLiteral = '{}';
    } catch {
      inputLiteral = '{}';
    }

    const outcome = await this.runInWorker(code, inputLiteral);
    if (!outcome.ok) return store({ error: `code: ${outcome.error}` });

    // La salida debe ser serializable y no enorme (no infla el contexto persistido).
    let serialized: string;
    try {
      serialized = JSON.stringify(outcome.out ?? null);
    } catch {
      return store({ error: 'code: la salida no es serializable (¿referencias circulares?).' });
    }
    if (serialized.length > 64_000) return store({ error: 'code: la salida es demasiado grande (máx. 64 KB).' });
    return store({ output: JSON.parse(serialized) });
  }

  private runInWorker(code: string, inputLiteral: string): Promise<{ ok: true; out: unknown } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: { ok: true; out: unknown } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        worker.terminate().catch(() => undefined);
        clearTimeout(killer);
        resolve(r);
      };
      const worker = new Worker(WORKER_SRC, {
        eval: true,
        env: {}, // sin secretos del proceso
        workerData: { code, inputLiteral, timeoutMs: this.timeoutMs },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      });
      // Margen sobre el timeout del vm: si el worker se cuelga (bucle, alloc), lo matamos igualmente.
      const killer = setTimeout(() => done({ ok: false, error: 'el script tardó demasiado (timeout).' }), this.timeoutMs + 1000);
      worker.once('message', (m: { ok: boolean; out?: unknown; error?: string }) =>
        done(m.ok ? { ok: true, out: m.out } : { ok: false, error: m.error ?? 'error desconocido' }),
      );
      worker.once('error', (e) => done({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    });
  }
}
