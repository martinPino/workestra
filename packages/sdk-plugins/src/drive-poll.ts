/**
 * Sondeo de Google Drive (M52): lista los ficheros de una carpeta MODIFICADOS desde la última vez, para el
 * trigger «Google Drive: nuevo fichero». Puro y con `fetch` inyectable → testeable sin red. El worker lo usa
 * con el token OAuth del conector de Drive; guarda el `newSince` para el próximo sondeo (así solo dispara por
 * ficheros nuevos, sin duplicar).
 */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

type Fetchish = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
type FetchBytes = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>;

/** Los formatos nativos de Google (Docs/Sheets/Slides) no se descargan con `alt=media`; requieren export. */
export function isNativeGoogleDoc(mimeType: string): boolean {
  return /^application\/vnd\.google-apps\./i.test(mimeType);
}

/**
 * Descarga los BYTES de un fichero binario de Drive (`alt=media`). `null` si es un doc nativo de Google
 * (no descargable así) o si la respuesta no es OK. Puro con `fetch` inyectable.
 */
export async function fetchDriveFileBytes(opts: {
  token: string;
  fileId: string;
  mimeType?: string;
  fetchFn?: FetchBytes;
}): Promise<Uint8Array | null> {
  if (opts.mimeType && isNativeGoogleDoc(opts.mimeType)) return null;
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchBytes);
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(opts.fileId)}?alt=media`;
  const res = await fetchFn(url, { headers: { authorization: `Bearer ${opts.token}` } });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

/** Construye la query de la Drive API v3 para «ficheros de esta carpeta modificados después de `sinceIso`». */
export function driveQuery(folderId: string | undefined, sinceIso: string): string {
  return [`modifiedTime > '${sinceIso}'`, folderId ? `'${folderId}' in parents` : '', 'trashed = false'].filter(Boolean).join(' and ');
}

/**
 * Devuelve los ficheros nuevos y el `newSince` a persistir (el `modifiedTime` máximo visto, o el `sinceIso` si
 * no hubo ninguno). Ordenados por `modifiedTime` ascendente para disparar en orden.
 */
export async function pollDriveFiles(opts: {
  token: string;
  folderId?: string;
  sinceIso: string;
  fetchFn?: Fetchish;
}): Promise<{ files: DriveFile[]; newSince: string }> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  const q = encodeURIComponent(driveQuery(opts.folderId, opts.sinceIso));
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime&pageSize=25`;
  const res = await fetchFn(url, { headers: { authorization: `Bearer ${opts.token}` } });
  if (!res.ok) return { files: [], newSince: opts.sinceIso }; // 401/red: no avanzamos el cursor, se reintenta
  const data = (await res.json()) as { files?: DriveFile[] };
  const files = (data.files ?? []).filter((f) => f && f.id && f.modifiedTime);
  const newSince = files.reduce((max, f) => (f.modifiedTime > max ? f.modifiedTime : max), opts.sinceIso);
  return { files, newSince };
}
