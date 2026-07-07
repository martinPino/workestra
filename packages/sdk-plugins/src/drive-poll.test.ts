import { describe, it, expect } from 'vitest';
import { driveQuery, pollDriveFiles, fetchDriveFileBytes, isNativeGoogleDoc, listDriveFolders, type DriveFile } from './drive-poll';

describe('driveQuery', () => {
  it('filtra por modificación posterior y no papelera', () => {
    const q = driveQuery(undefined, '2026-07-07T00:00:00.000Z');
    expect(q).toContain("modifiedTime > '2026-07-07T00:00:00.000Z'");
    expect(q).toContain('trashed = false');
    expect(q).not.toContain('in parents');
  });
  it('acota a una carpeta cuando se indica folderId', () => {
    const q = driveQuery('FOLDER123', '2026-07-07T00:00:00.000Z');
    expect(q).toContain("'FOLDER123' in parents");
  });
});

describe('isNativeGoogleDoc', () => {
  it('detecta formatos nativos de Google (no descargables con alt=media)', () => {
    expect(isNativeGoogleDoc('application/vnd.google-apps.document')).toBe(true);
    expect(isNativeGoogleDoc('application/pdf')).toBe(false);
    expect(isNativeGoogleDoc('image/png')).toBe(false);
  });
});

const file = (id: string, modifiedTime: string): DriveFile => ({ id, name: `${id}.pdf`, mimeType: 'application/pdf', modifiedTime });

describe('pollDriveFiles', () => {
  it('devuelve los ficheros y avanza el cursor al modifiedTime máximo', async () => {
    const files = [file('a', '2026-07-07T10:00:00.000Z'), file('b', '2026-07-07T12:00:00.000Z')];
    const res = await pollDriveFiles({
      token: 'secret-token',
      sinceIso: '2026-07-07T00:00:00.000Z',
      fetchFn: async (url, init) => {
        expect(url).toContain('drive/v3/files');
        expect(url).not.toContain('secret-token'); // el token va en la cabecera, no en la URL
        expect(init?.headers?.authorization).toBe('Bearer secret-token');
        return { ok: true, json: async () => ({ files }) };
      },
    });
    expect(res.files.map((f) => f.id)).toEqual(['a', 'b']);
    expect(res.newSince).toBe('2026-07-07T12:00:00.000Z');
  });

  it('sin ficheros nuevos: mantiene el cursor', async () => {
    const res = await pollDriveFiles({
      token: 't',
      sinceIso: '2026-07-07T00:00:00.000Z',
      fetchFn: async () => ({ ok: true, json: async () => ({ files: [] }) }),
    });
    expect(res.files).toEqual([]);
    expect(res.newSince).toBe('2026-07-07T00:00:00.000Z');
  });

  it('en error (401/red) no avanza el cursor y no dispara', async () => {
    const res = await pollDriveFiles({
      token: 't',
      sinceIso: '2026-07-07T00:00:00.000Z',
      fetchFn: async () => ({ ok: false, json: async () => ({}) }),
    });
    expect(res.files).toEqual([]);
    expect(res.newSince).toBe('2026-07-07T00:00:00.000Z');
  });

  it('descarta filas sin id o sin modifiedTime (robustez)', async () => {
    const res = await pollDriveFiles({
      token: 't',
      sinceIso: '2026-07-07T00:00:00.000Z',
      fetchFn: async () => ({
        ok: true,
        json: async () => ({ files: [file('a', '2026-07-07T10:00:00.000Z'), { id: '', name: 'x', mimeType: 'application/pdf', modifiedTime: '2026-07-07T11:00:00.000Z' }] }),
      }),
    });
    expect(res.files.map((f) => f.id)).toEqual(['a']);
  });
});

describe('listDriveFolders', () => {
  it('consulta solo carpetas no papelera y devuelve id+nombre', async () => {
    const res = await listDriveFolders({
      token: 'tok',
      fetchFn: async (url, init) => {
        expect(decodeURIComponent(url)).toContain("mimeType = 'application/vnd.google-apps.folder'");
        expect(decodeURIComponent(url)).toContain('trashed = false');
        expect(init?.headers?.authorization).toBe('Bearer tok');
        return { ok: true, json: async () => ({ files: [{ id: 'f1', name: 'Facturas' }, { id: 'f2', name: 'Recibos' }] }) };
      },
    });
    expect(res.folders).toEqual([{ id: 'f1', name: 'Facturas' }, { id: 'f2', name: 'Recibos' }]);
  });

  it('descarta filas sin id o sin nombre, y devuelve [] en error', async () => {
    const bad = await listDriveFolders({ token: 't', fetchFn: async () => ({ ok: true, json: async () => ({ files: [{ id: '', name: 'x' }, { id: 'ok', name: 'Buena' }] }) }) });
    expect(bad.folders).toEqual([{ id: 'ok', name: 'Buena' }]);
    const err = await listDriveFolders({ token: 't', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
    expect(err.folders).toEqual([]);
  });
});

describe('fetchDriveFileBytes', () => {
  it('descarga los bytes de un fichero binario con alt=media y Bearer', async () => {
    const payload = new TextEncoder().encode('PDF-bytes');
    const bytes = await fetchDriveFileBytes({
      token: 'tok',
      fileId: 'abc',
      mimeType: 'application/pdf',
      fetchFn: async (url, init) => {
        expect(url).toContain('/drive/v3/files/abc?alt=media');
        expect(init?.headers?.authorization).toBe('Bearer tok');
        return { ok: true, status: 200, arrayBuffer: async () => payload.buffer };
      },
    });
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe('PDF-bytes');
  });

  it('devuelve null para docs nativos de Google (requieren export)', async () => {
    const bytes = await fetchDriveFileBytes({
      token: 'tok',
      fileId: 'abc',
      mimeType: 'application/vnd.google-apps.document',
      fetchFn: async () => {
        throw new Error('no debería llamarse');
      },
    });
    expect(bytes).toBeNull();
  });

  it('devuelve null si la descarga no es OK', async () => {
    const bytes = await fetchDriveFileBytes({
      token: 'tok',
      fileId: 'abc',
      mimeType: 'application/pdf',
      fetchFn: async () => ({ ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    expect(bytes).toBeNull();
  });
});
