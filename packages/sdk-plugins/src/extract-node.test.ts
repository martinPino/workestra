import { describe, it, expect } from 'vitest';
import { emptyContext } from '@core/contracts';
import type { IFileStore, FileRef, StoredFile } from '@core/engine';
import { ExtractTextNodeExecutor } from './extract-node';

/** File store falso con un fichero precargado. */
class FakeFileStore implements IFileStore {
  constructor(private readonly file: StoredFile | null) {}
  async put(): Promise<FileRef> {
    return { id: 'f1', name: 'x', mimeType: 'text/plain', size: 0 };
  }
  async get(_ws: string, id: string): Promise<StoredFile | null> {
    return id === 'f1' ? this.file : null;
  }
}

const run = (file: StoredFile | null, fileId: string, opts: { files?: IFileStore; ocr?: (b: Uint8Array, l: string) => Promise<string> } = {}) =>
  new ExtractTextNodeExecutor(opts.files ?? new FakeFileStore(file), opts.ocr).execute({
    executionId: 'e1',
    workspaceId: 'ws1',
    nodeKey: 'extraer',
    config: { fileId },
    context: { ...emptyContext(), variables: {} },
    signal: new AbortController().signal,
    emit: () => {},
  });

const out = (r: Awaited<ReturnType<typeof run>>) => r.context.variables['text:extraer'] as { text?: string; error?: string; chars?: number };

describe('ExtractTextNodeExecutor (nodo Extraer texto, M49)', () => {
  it('decodifica un fichero de texto/CSV y deja el texto en {{text:KEY.text}}', async () => {
    const file: StoredFile = { name: 'datos.csv', mimeType: 'text/csv', bytes: new TextEncoder().encode('id,nombre\n1,Ada') };
    const res = await run(file, 'f1');
    expect(out(res).text).toBe('id,nombre\n1,Ada');
    expect(out(res).chars).toBe(15);
    expect(res.control).toEqual({ kind: 'continue' });
  });

  it('acepta la referencia como id suelto o como objeto {{file:KEY}} (JSON con .id)', async () => {
    const file: StoredFile = { name: 't.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('hola') };
    expect(out(await run(file, 'f1')).text).toBe('hola'); // id suelto
    expect(out(await run(file, '{"id":"f1","name":"t.txt"}')).text).toBe('hola'); // objeto JSON
  });

  it('una imagen (foto/escaneo) va por OCR y devuelve su texto (M50)', async () => {
    const img: StoredFile = { name: 'factura.jpg', mimeType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) };
    let seenLang = '';
    const res = await run(img, 'f1', {
      ocr: async (_bytes, lang) => {
        seenLang = lang;
        return 'FACTURA Nº 42\nTotal: 100€';
      },
    });
    expect(out(res).text).toBe('FACTURA Nº 42\nTotal: 100€');
    expect(seenLang).toBe('eng+spa'); // idioma por defecto: español + inglés
  });

  // Google Drive entrega PDFs válidos con `Content-Type: application/octet-stream`. Fiarse de la etiqueta
  // hacía que `extract` rechazara facturas reales; ahora se mira el CONTENIDO (la firma `%PDF`).
  it('reconoce un PDF entregado como octet-stream por su firma, no por la etiqueta', async () => {
    // Un PDF mínimo válido: empieza por «%PDF-1.4». pdf-parse extrae poco, pero no debe dar «no soportado».
    const pdfBytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    const pdf: StoredFile = { name: 'factura', mimeType: 'application/octet-stream', bytes: pdfBytes };
    const r = await run(pdf, 'f1');
    // No es «tipo no soportado»: fue por la rama PDF (extrajo, o avisó de que no tiene capa de texto).
    expect(out(r).error ?? '').not.toContain('no soportado');
  });

  it('reconoce una imagen octet-stream por su número mágico y la manda a OCR', async () => {
    const jpg: StoredFile = { name: 'recibo', mimeType: 'application/octet-stream', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
    const r = await run(jpg, 'f1', { ocr: async () => 'TOTAL 100' });
    expect(out(r).text).toBe('TOTAL 100');
  });

  it('un octet-stream SIN firma se intenta como texto (mal etiquetado, no basura binaria)', async () => {
    const txt: StoredFile = { name: 'datos', mimeType: 'application/octet-stream', bytes: new TextEncoder().encode('columna1,columna2') };
    expect(out(await run(txt, 'f1')).text).toBe('columna1,columna2');
  });

  it('errores legibles sin romper el flujo: sin fichero, no encontrado, tipo no soportado', async () => {
    expect(out(await run(null, '')).error).toContain('indica el fichero');
    expect(out(await run(null, 'noexiste')).error).toContain('no se encontró');
    const bin: StoredFile = { name: 'a.zip', mimeType: 'application/zip', bytes: new Uint8Array([1, 2, 3]) };
    const r = await run(bin, 'f1');
    expect(out(r).error).toContain('no soportado');
    expect(r.control).toEqual({ kind: 'continue' });
  });
});
