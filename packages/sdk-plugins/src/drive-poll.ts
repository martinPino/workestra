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

export interface DriveFolder {
  id: string;
  name: string;
}

export interface DriveFoldersResult {
  folders: DriveFolder[];
  /**
   * Presente SOLO cuando Google rechazó la petición. Antes se devolvía `{folders: []}` ante cualquier fallo, lo
   * que convertía un 403 (scope de Drive no concedido, API no habilitada) en un desplegable vacío sin
   * explicación: el usuario no sabía si su Drive estaba vacío o si algo había fallado. Ahora el motivo real
   * viaja hasta el servicio, que lo registra y lo expone para que la UI ofrezca reconectar / pegar el ID.
   */
  error?: { status?: number; message: string };
}

/**
 * Lista las CARPETAS del Drive del usuario (para poblar el desplegable del trigger, M54). Devuelve hasta 100
 * carpetas no papelera, ordenadas por nombre. Puro con `fetch` inyectable → testeable. Un Drive sin carpetas es
 * `{folders: []}` sin `error`; un rechazo de Google es `{folders: [], error}` con el motivo de Google.
 */
export async function listDriveFolders(opts: { token: string; fetchFn?: Fetchish }): Promise<DriveFoldersResult> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as Fetchish);
  const q = encodeURIComponent("mimeType = 'application/vnd.google-apps.folder' and trashed = false");
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=name&pageSize=100`;
  const res = await fetchFn(url, { headers: { authorization: `Bearer ${opts.token}` } });
  if (!res.ok) {
    // Google devuelve el detalle como JSON `{error:{message,status}}`; lo extraemos para diagnosticar (el
    // caso típico es 403 por scope de Drive no consentido). Cuerpo no-JSON → mensaje genérico.
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const message = body.error?.message || 'Google Drive rechazó la petición.';
    return { folders: [], error: { status: (res as { status?: number }).status, message } };
  }
  const data = (await res.json().catch(() => ({}))) as { files?: DriveFolder[] }; // cuerpo no-JSON con 2xx → []
  const folders = (data.files ?? []).filter((f) => f && f.id && typeof f.name === 'string');
  return { folders };
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
  const data = (await res.json().catch(() => ({}))) as { files?: DriveFile[] }; // cuerpo no-JSON con 2xx → no dispara
  const files = (data.files ?? []).filter((f) => f && f.id && f.modifiedTime);
  const newSince = files.reduce((max, f) => (f.modifiedTime > max ? f.modifiedTime : max), opts.sinceIso);
  return { files, newSince };
}
