import { describe, it, expect, vi, afterEach } from 'vitest';
import { emptyContext } from '@core/contracts';
import type { IFileStore, FileRef, StoredFile } from '@core/engine';
import { DownloadFileNodeExecutor } from './download-node';

/** File store falso (evita acoplar sdk-plugins a infra); registra lo que se guardó. */
class FakeFileStore implements IFileStore {
  saved: { workspaceId: string; file: StoredFile } | null = null;
  async put(workspaceId: string, file: StoredFile): Promise<FileRef> {
    this.saved = { workspaceId, file };
    return { id: 'f1', name: file.name, mimeType: file.mimeType, size: file.bytes.byteLength };
  }
  async get(): Promise<StoredFile | null> {
    return this.saved?.file ?? null;
  }
}

const run = (files: IFileStore | undefined, url: string) =>
  new DownloadFileNodeExecutor(files).execute({
    executionId: 'e1',
    workspaceId: 'ws1',
    nodeKey: 'bajar',
    config: { url },
    context: { ...emptyContext(), variables: {} },
    signal: new AbortController().signal,
    emit: () => {},
  });

afterEach(() => vi.unstubAllGlobals());

describe('DownloadFileNodeExecutor (nodo Descargar fichero, M48)', () => {
  it('descarga, guarda los bytes en el file store y deja una referencia en {{file:KEY}}', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('id,nombre\n1,Ada', { status: 200, headers: { 'content-type': 'text/csv' } })));
    const store = new FakeFileStore();
    const res = await run(store, 'https://ejemplo.com/datos.csv');
    const out = res.context.variables['file:bajar'] as FileRef & { text?: string };
    expect(out.id).toBe('f1');
    expect(out.name).toBe('datos.csv');
    expect(out.mimeType).toBe('text/csv');
    expect(out.text).toBe('id,nombre\n1,Ada'); // texto pequeño → también accesible como {{file:bajar.text}}
    expect(store.saved?.workspaceId).toBe('ws1'); // guardado bajo el workspace de la ejecución
    expect(res.control).toEqual({ kind: 'continue' });
  });

  it('un binario (PDF) se guarda pero NO se expone como texto', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    vi.stubGlobal('fetch', vi.fn(async () => new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } })));
    const res = await run(new FakeFileStore(), 'https://ejemplo.com/factura.pdf');
    const out = res.context.variables['file:bajar'] as FileRef & { text?: string };
    expect(out.mimeType).toBe('application/pdf');
    expect(out.size).toBe(4);
    expect(out.text).toBeUndefined();
  });

  it('error legible si la URL es inválida o no hay almacén (sin romper el flujo)', async () => {
    const sinUrl = await run(new FakeFileStore(), 'no-es-url');
    expect((sinUrl.context.variables['file:bajar'] as { error: string }).error).toContain('falta la URL');
    const sinStore = await run(undefined, 'https://ejemplo.com/x.pdf');
    expect((sinStore.context.variables['file:bajar'] as { error: string }).error).toContain('no disponible');
    expect(sinUrl.control).toEqual({ kind: 'continue' });
  });
});
