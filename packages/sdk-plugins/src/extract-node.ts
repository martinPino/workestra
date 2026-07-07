import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType } from '@core/contracts';
import type { IFileStore } from '@core/engine';
import { interpolate } from './interpolate';

const MAX_TEXT = 300_000; // tope del texto extraído (no infla el contexto persistido).

type PdfParse = (buf: Buffer) => Promise<{ text?: string }>;
// Lazy require: solo se carga pdf-parse cuando llega un PDF (evita cargar la librería —y su bloque de debug—
// si el fichero es texto/CSV). En el runtime CJS `module.parent` está puesto, así que no dispara el debug.
function loadPdfParse(): PdfParse {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('pdf-parse') as PdfParse;
}

/** Acepta un id suelto o una referencia `{{file:KEY}}` (objeto JSON con `.id`) ya interpolada. */
function fileIdOf(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s) as { id?: unknown };
      if (typeof o.id === 'string') return o.id;
    } catch {
      /* no era JSON: se trata como id */
    }
  }
  return s;
}

/**
 * Nodo «Extraer texto» (M49): lee un fichero del file store (por su referencia, p. ej. `{{file:descargar.id}}`)
 * y saca su TEXTO. Para PDF de texto usa pdf-parse; para texto/CSV/JSON lo decodifica. Deja el texto en
 * `{{text:KEY.text}}` para que un LLM/agente lo procese (p. ej. extraer los datos de una factura). El OCR de
 * PDFs escaneados (sin capa de texto) queda para un paso posterior.
 */
export class ExtractTextNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'extract';
  constructor(private readonly files?: IFileStore) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const store = (result: Record<string, unknown>): NodeResult => ({
      context: { ...ctx.context, variables: { ...ctx.context.variables, [`text:${ctx.nodeKey}`]: result } },
      control: { kind: 'continue' },
    });
    if (!this.files) return store({ error: 'extract: almacén de ficheros no disponible.' });
    const id = fileIdOf(interpolate(String(ctx.config.fileId ?? ''), ctx.context));
    if (!id) return store({ error: 'extract: indica el fichero (p. ej. {{file:descargar.id}}).' });

    const file = await this.files.get(ctx.workspaceId, id);
    if (!file) return store({ error: 'extract: no se encontró el fichero (¿caducó?).' });

    let text: string;
    try {
      if (/pdf/i.test(file.mimeType)) {
        const r = await loadPdfParse()(Buffer.from(file.bytes));
        text = (r.text ?? '').trim();
        if (!text) {
          return store({ name: file.name, chars: 0, text: '', note: 'PDF sin capa de texto (¿escaneado? el OCR llega en un paso posterior).' });
        }
      } else if (/^text\/|json|xml|csv/i.test(file.mimeType)) {
        text = new TextDecoder().decode(file.bytes);
      } else {
        return store({ error: `extract: tipo de fichero no soportado (${file.mimeType}).` });
      }
    } catch (e) {
      return store({ error: `extract: no se pudo leer el fichero: ${e instanceof Error ? e.message : String(e)}` });
    }

    const truncated = text.length > MAX_TEXT;
    return store({ name: file.name, chars: text.length, truncated, text: truncated ? text.slice(0, MAX_TEXT) : text });
  }
}
