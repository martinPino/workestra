/**
 * Tokens OAuth con RENOVACIÓN (M28). Los proveedores modernos (Google, Atlassian…) emiten access tokens
 * de vida corta (~1 h) + un refresh token. Antes solo guardábamos el access token suelto, así que el
 * conector moría a la hora. Ahora el secreto guarda un blob {access_token, refresh_token, expires_at} y
 * este módulo lo renueva de forma transparente antes de usarlo. Compatible hacia atrás: un secreto que sea
 * un string suelto se trata como «solo access token, sin refresh».
 */
import { getConnectorProvider, providerEnvKeys } from './connector-providers';

export interface TokenBlob {
  access_token: string;
  refresh_token?: string;
  /** Epoch en ms en el que caduca el access token (undefined = no caduca / desconocido). */
  expires_at?: number;
}

/** Fetch mínimo (para inyectar el global o un mock en tests). */
export type Fetchish = (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const asRecord = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});

/** Lee el secreto: blob JSON nuevo o string suelto (legacy = solo access token). */
export function parseTokenBlob(raw: string): TokenBlob {
  if (raw && raw.charCodeAt(0) === 123 /* '{' */) {
    const o = asRecord((() => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })());
    if (typeof o.access_token === 'string' && o.access_token) {
      return {
        access_token: o.access_token,
        refresh_token: typeof o.refresh_token === 'string' ? o.refresh_token : undefined,
        expires_at: typeof o.expires_at === 'number' ? o.expires_at : undefined,
      };
    }
  }
  return { access_token: raw };
}

/** Serializa para persistir. Sin refresh ni expiry, guarda el string suelto (compat con lectores legacy). */
export function serializeTokenBlob(b: TokenBlob): string {
  if (!b.refresh_token && !b.expires_at) return b.access_token;
  return JSON.stringify({ access_token: b.access_token, refresh_token: b.refresh_token, expires_at: b.expires_at });
}

/** Construye el blob desde la respuesta del token endpoint. `nowMs` para calcular `expires_at`. */
export function tokenBlobFromResponse(tok: Record<string, unknown>, accessToken: string, nowMs: number): TokenBlob {
  const refresh = typeof tok.refresh_token === 'string' ? tok.refresh_token : undefined;
  const expiresIn = typeof tok.expires_in === 'number' ? tok.expires_in : undefined;
  return { access_token: accessToken, refresh_token: refresh, expires_at: expiresIn ? nowMs + expiresIn * 1000 : undefined };
}

/** Credenciales del cliente OAuth desde env (resolviendo `configProvider`). `null` si no están configuradas. */
export function providerClientCreds(providerKey: string): { clientId: string; clientSecret: string } | null {
  const prov = getConnectorProvider(providerKey);
  const base = prov?.configProvider ?? providerKey;
  const { id, secret } = providerEnvKeys(base);
  const clientId = process.env[id];
  const clientSecret = process.env[secret];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** ¿El access token está caducado (o a <60 s de caducar) y hay con qué renovarlo? */
export function needsRefresh(blob: TokenBlob, nowMs: number): boolean {
  return !!blob.refresh_token && typeof blob.expires_at === 'number' && nowMs >= blob.expires_at - 60_000;
}

/**
 * Renueva el access token con el refresh token (`grant_type=refresh_token`). Devuelve el blob nuevo (con el
 * refresh conservado, pues Google no manda uno nuevo) o `null` si no se pudo (sin credenciales, red, etc.).
 */
export async function refreshAccessToken(providerKey: string, blob: TokenBlob, nowMs: number, fetchFn: Fetchish): Promise<TokenBlob | null> {
  const prov = getConnectorProvider(providerKey);
  if (!prov || !blob.refresh_token) return null;
  const creds = providerClientCreds(providerKey);
  if (!creds) return null;
  const fields: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: blob.refresh_token,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  };
  try {
    const res =
      prov.tokenExchange === 'form'
        ? await fetchFn(prov.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: new URLSearchParams(fields).toString(),
          })
        : await fetchFn(prov.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(fields),
          });
    if (!res.ok) return null;
    const tok = asRecord(await res.json().catch(() => ({})));
    const access = typeof tok.access_token === 'string' ? tok.access_token : '';
    if (!access) return null;
    // El endpoint de refresh normalmente NO devuelve un refresh nuevo: conservamos el anterior.
    return tokenBlobFromResponse({ ...tok, refresh_token: tok.refresh_token ?? blob.refresh_token }, access, nowMs);
  } catch {
    return null;
  }
}
