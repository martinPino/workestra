import { describe, it, expect } from 'vitest';
import { driveQuery, pollDriveFiles, fetchDriveFileBytes, isNativeGoogleDoc, listDriveFolders, type DriveFile } from './drive-poll';

describe('driveQuery', () => {
  it('filtra por ENTRADA en Drive (createdTime) posterior y no papelera', () => {
    const q = driveQuery(undefined, '2026-07-07T00:00:00.000Z');
    expect(q).toContain("createdTime > '2026-07-07T00:00:00.000Z'");
    // Por `modifiedTime` NO: Drive conserva la fecha del fichero de origen al subirlo, así que un PDF
    // creado ayer y subido hoy nunca dispararía (ver el test de regresión de `pollDriveFiles`).
    expect(q).not.toContain('modifiedTime');
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

/** Fichero de Drive. `createdTime` (subida) manda; `modifiedTime` por defecto imita el caso real: MÁS VIEJO. */
const file = (id: string, createdTime: string, modifiedTime = '2020-01-01T00:00:00.000Z'): DriveFile => ({
  id,
  name: `${id}.pdf`,
  mimeType: 'application/pdf',
  modifiedTime,
  createdTime,
});

describe('pollDriveFiles', () => {
  // REGRESIÓN: subes a Drive un PDF que creaste ayer (o que descargaste) — Drive le conserva la fecha de
  // modificación ORIGINAL, muy anterior al cursor. Con el filtro por `modifiedTime` el fichero nacía «viejo»
  // y no disparaba nunca, por más veces que se volviera a subir. Es el caso NORMAL, no un borde.
  it('dispara por un fichero SUBIDO ahora aunque su modifiedTime sea antiquísimo', async () => {
    const recienSubido = file('factura', '2026-07-07T16:36:00.000Z', '2026-07-06T06:50:00.000Z');
    const res = await pollDriveFiles({
      token: 't',
      sinceIso: '2026-07-07T16:00:00.000Z', // posterior al modifiedTime, anterior a la subida
      fetchFn: async (url) => {
        const u = decodeURIComponent(url);
        // El FILTRO va por createdTime… (no basta con que la palabra aparezca en `fields`)
        expect(u).toContain("createdTime > '2026-07-07T16:00:00.000Z'");
        expect(u).not.toContain('modifiedTime >');
        // …y el ORDEN también: la paginación (pageSize=25) recorta por el criterio de orden, así que ordenar
        // por `modifiedTime` devolvería un lote arbitrario respecto a la subida y el cursor saltaría por
        // encima de ficheros no vistos. Sin esta aserción, revertir solo el orderBy pasaba desapercibido.
        expect(u).toContain('orderBy=createdTime');
        return { ok: true, json: async () => ({ files: [recienSubido] }) };
      },
    });
    expect(res.files.map((f) => f.id)).toEqual(['factura']);
    expect(res.newSince).toBe('2026-07-07T16:36:00.000Z'); // el cursor avanza por createdTime
  });

  it('devuelve los ficheros y avanza el cursor al createdTime máximo', async () => {
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

  it('descarta filas sin id o sin createdTime (robustez)', async () => {
    const res = await pollDriveFiles({
      token: 't',
      sinceIso: '2026-07-07T00:00:00.000Z',
      fetchFn: async () => ({
        ok: true,
        json: async () => ({
          files: [
            file('a', '2026-07-07T10:00:00.000Z'),
            { id: '', name: 'x', mimeType: 'application/pdf', modifiedTime: '2026-07-07T11:00:00.000Z', createdTime: '2026-07-07T11:00:00.000Z' },
            // Sin `createdTime` no se puede situar en el tiempo: se descarta y NO contamina el cursor.
            { id: 'sin-fecha', name: 'y.pdf', mimeType: 'application/pdf', modifiedTime: '2026-07-07T23:00:00.000Z' } as DriveFile,
          ],
        }),
      }),
    });
    expect(res.files.map((f) => f.id)).toEqual(['a']);
    expect(res.newSince).toBe('2026-07-07T10:00:00.000Z'); // no avanzó por la fila sin createdTime
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

  it('descarta filas sin id o sin nombre', async () => {
    const bad = await listDriveFolders({ token: 't', fetchFn: async () => ({ ok: true, json: async () => ({ files: [{ id: '', name: 'x' }, { id: 'ok', name: 'Buena' }] }) }) });
    expect(bad.folders).toEqual([{ id: 'ok', name: 'Buena' }]);
    expect(bad.error).toBeUndefined();
  });

  it('un Drive sin carpetas es [] SIN error (no es un fallo)', async () => {
    const empty = await listDriveFolders({ token: 't', fetchFn: async () => ({ ok: true, json: async () => ({ files: [] }) }) });
    expect(empty.folders).toEqual([]);
    expect(empty.error).toBeUndefined();
  });

  it('un rechazo de Google expone el motivo (no lo traga como Drive vacío)', async () => {
    const err = await listDriveFolders({
      token: 't',
      // Google devuelve el detalle como {error:{message,...}} con el status HTTP.
      fetchFn: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Insufficient Permission' } }) }),
    });
    expect(err.folders).toEqual([]);
    expect(err.error).toEqual({ status: 403, message: 'Insufficient Permission' });
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
