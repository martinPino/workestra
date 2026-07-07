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

const run = (file: StoredFile | null, fileId: string, files?: IFileStore) =>
  new ExtractTextNodeExecutor(files ?? new FakeFileStore(file)).execute({
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

  it('errores legibles sin romper el flujo: sin fichero, no encontrado, tipo no soportado', async () => {
    expect(out(await run(null, '')).error).toContain('indica el fichero');
    expect(out(await run(null, 'noexiste')).error).toContain('no se encontró');
    const bin: StoredFile = { name: 'a.zip', mimeType: 'application/zip', bytes: new Uint8Array([1, 2, 3]) };
    const r = await run(bin, 'f1');
    expect(out(r).error).toContain('no soportado');
    expect(r.control).toEqual({ kind: 'continue' });
  });
});
