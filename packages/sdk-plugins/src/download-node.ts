import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType } from '@core/contracts';
import type { IFileStore } from '@core/engine';
import { interpolate } from './interpolate';
import { parseHeaders } from './executors-io';

const MAX_BYTES = 15_000_000; // 15 MB: tope por fichero (evita agotar Redis/memoria).
const MAX_INLINE_TEXT = 200_000; // texto/JSON/CSV pequeño se expone también como {{file:KEY.text}}.

/** Deriva un nombre de fichero de la URL (último segmento) o de Content-Disposition. */
function fileName(url: string, disposition: string | null): string {
  const fromCd = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
  if (fromCd) return decodeURIComponent(fromCd);
  const path = url.split('?')[0].split('#')[0];
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last || 'fichero';
}

function isTextual(mime: string): boolean {
  return /^text\/|application\/(json|xml|csv)|\+xml|\+json/i.test(mime);
}

/**
 * Nodo «Descargar fichero» (M48): descarga una URL y guarda los BYTES en el file store (fuera del contexto),
 * dejando en `{{file:KEY}}` una referencia ligera { id, name, mimeType, size }. Es el productor de ficheros
 * del flujo (p. ej. traer un PDF/CSV desde un enlace) que otros nodos consumirán (extraer texto, subir…).
 * Para ficheros de TEXTO pequeños expone además el contenido en `{{file:KEY.text}}` para uso inmediato.
 * URL y cabeceras admiten {{variables}} (así puedes meter tu API key o un enlace de un paso previo).
 */
export class DownloadFileNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'download';
  constructor(
    private readonly files?: IFileStore,
    private readonly timeoutMs = 30_000,
  ) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const store = (result: Record<string, unknown>): NodeResult => ({
      context: { ...ctx.context, variables: { ...ctx.context.variables, [`file:${ctx.nodeKey}`]: result } },
      control: { kind: 'continue' },
    });
    if (!this.files) return store({ error: 'download: almacén de ficheros no disponible.' });
    const url = interpolate(String(ctx.config.url ?? ''), ctx.context);
    if (!/^https?:\/\//i.test(url)) return store({ error: 'download: falta la URL (http/https) en la config.' });

    const headers = parseHeaders(interpolate(String(ctx.config.headers ?? ''), ctx.context, true));
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal });
      if (!res.ok) return store({ error: `download: HTTP ${res.status} al descargar.`, status: res.status });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) return store({ error: `download: el fichero supera el máximo (${Math.round(MAX_BYTES / 1e6)} MB).` });
      const mimeType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
      const name = fileName(url, res.headers.get('content-disposition'));

      const ref = await this.files.put(ctx.workspaceId, { name, mimeType, bytes: buf });
      const out: Record<string, unknown> = { ...ref };
      // Texto/JSON/CSV pequeño: se expone decodificado para poder usarlo sin un nodo de extracción.
      if (isTextual(mimeType) && buf.byteLength <= MAX_INLINE_TEXT) {
        out.text = new TextDecoder().decode(buf);
      }
      return store(out);
    } catch (e) {
      return store({ error: `download: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
}
