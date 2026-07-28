import type { INodeExecutor, NodeExecutionContext, NodeResult, NodeType } from '@core/contracts';
import type { IFileStore } from '@core/engine';
import { interpolate } from './interpolate';

const MAX_TEXT = 300_000; // tope del texto extraído (no infla el contexto persistido).
const OCR_TIMEOUT = 90_000; // el OCR de una imagen puede tardar (descarga el modelo la 1ª vez).

type PdfParse = (buf: Buffer) => Promise<{ text?: string }>;
// Lazy require: solo se carga pdf-parse cuando llega un PDF (evita cargar la librería —y su bloque de debug—
// si el fichero es texto/CSV). En el runtime CJS `module.parent` está puesto, así que no dispara el debug.
function loadPdfParse(): PdfParse {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('pdf-parse') as PdfParse;
}

/** Función de OCR (inyectable para tests). Recibe los bytes de una imagen + idioma; devuelve el texto. */
export type OcrFn = (bytes: Uint8Array, lang: string) => Promise<string>;

/** OCR por defecto con tesseract.js (WASM puro; lazy-require: solo se carga cuando llega una imagen). */
async function tesseractOcr(bytes: Uint8Array, lang: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createWorker } = require('tesseract.js') as typeof import('tesseract.js');
  const worker = await createWorker(lang);
  try {
    const { data } = await worker.recognize(Buffer.from(bytes));
    return String(data?.text ?? '').trim();
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('el OCR tardó demasiado')), ms))]);
}

/**
 * Tipo REAL del fichero, mirando primero sus bytes y solo después la etiqueta MIME.
 *
 * Google Drive (y muchos servidores) entregan un PDF perfectamente válido con `Content-Type:
 * application/octet-stream` —«unos bytes cualesquiera»—, así que fiarse solo de la etiqueta hacía que
 * `extract` rechazara facturas reales. Los formatos que nos importan empiezan por una firma inequívoca:
 * un PDF por `%PDF`, un PNG/JPG/GIF por su número mágico. Se comprueban esas firmas ANTES de creer la
 * etiqueta; si el contenido no dice nada, se cae a lo que diga el MIME.
 */
function detectKind(bytes: Uint8Array, mimeType: string): 'pdf' | 'image' | 'text' | 'unknown' {
  const b = bytes;
  // %PDF
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  // PNG (89 50 4E 47), JPEG (FF D8 FF), GIF (47 49 46)
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image';
  // Sin firma reconocible: la etiqueta decide.
  if (/pdf/i.test(mimeType)) return 'pdf';
  if (/^image\//i.test(mimeType)) return 'image';
  if (/^text\/|json|xml|csv/i.test(mimeType)) return 'text';
  // `octet-stream` sin firma: lo más probable es texto plano mal etiquetado; se intenta como texto.
  if (/octet-stream/i.test(mimeType)) return 'text';
  return 'unknown';
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
 * Nodo «Extraer texto» (M49/M50): lee un fichero del file store (por su referencia, p. ej.
 * `{{file:descargar.id}}`) y saca su TEXTO. PDF de texto → pdf-parse; IMÁGENES (foto/escaneo de una factura o
 * recibo) → OCR con tesseract.js; texto/CSV/JSON → decodificación. Deja el texto en `{{text:KEY.text}}` para
 * que un LLM/agente lo procese (p. ej. extraer los datos de la factura).
 */
export class ExtractTextNodeExecutor implements INodeExecutor {
  readonly type: NodeType = 'extract';
  constructor(
    private readonly files?: IFileStore,
    private readonly ocr: OcrFn = tesseractOcr, // inyectable en tests
  ) {}

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

    // Por CONTENIDO, no por la etiqueta: Drive entrega PDFs válidos como `octet-stream` (ver detectKind).
    const kind = detectKind(file.bytes, file.mimeType);
    let text: string;
    try {
      if (kind === 'pdf') {
        const r = await loadPdfParse()(Buffer.from(file.bytes));
        text = (r.text ?? '').trim();
        if (!text) {
          return store({ name: file.name, chars: 0, text: '', note: 'PDF sin capa de texto (¿escaneado? sube la imagen y usa OCR).' });
        }
      } else if (kind === 'image') {
        // M50: imagen (foto/escaneo) → OCR. Idioma configurable; por defecto español + inglés.
        const lang = String(ctx.config.lang ?? '').trim() || 'eng+spa';
        text = (await withTimeout(this.ocr(file.bytes, lang), OCR_TIMEOUT)).trim();
        if (!text) return store({ name: file.name, chars: 0, text: '', note: 'No se detectó texto en la imagen.' });
      } else if (kind === 'text') {
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
