import type { Role } from '@core/contracts';
import { UnauthorizedException } from './common';

/**
 * JWT HS256 sobre WebCrypto, en sustitución de `@nestjs/jwt`.
 *
 * `@nestjs/jwt` envuelve `jsonwebtoken`, que usa el `crypto` de Node de forma síncrona. WebCrypto es
 * asíncrono, así que estas funciones devuelven promesas — de ahí que el middleware de auth sea `async`
 * donde el guard de Nest era síncrono.
 *
 * COMPATIBLE CON LOS TOKENS YA EMITIDOS: mismo algoritmo (HS256) y mismo `JWT_SECRET`, así que las
 * sesiones firmadas por el API de Railway se validan aquí y viceversa. Es lo que permite la convivencia
 * de la fase 3 sin echar a todo el mundo de su sesión.
 */

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  workspaceId: string;
  /** Segundos desde epoch. Lo pone `signJwt`. */
  iat?: number;
  exp?: number;
  /**
   * Marca los tokens que NO son de sesión (p. ej. el `oauth_state` de conectores, firmado con el mismo
   * secreto). Un token de sesión no lo lleva; el middleware rechaza los que sí.
   */
  kind?: string;
}

const encoder = new TextEncoder();

/** base64url sin padding, el encoding que exige JWT (base64 normal rompe el token en una URL). */
function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// El tipo de retorno se fija a `Uint8Array<ArrayBuffer>` (no `ArrayBufferLike`) porque `crypto.subtle`
// exige un `BufferSource` respaldado por un ArrayBuffer real, no por un SharedArrayBuffer.
function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Firma un JWT HS256. `expiresInSeconds` por defecto 7 días, igual que `SESSION_TTL` del AuthService. */
export async function signJwt(payload: JwtPayload, secret: string, expiresInSeconds = 7 * 24 * 3600): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat, exp: iat + expiresInSeconds };
  const head = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const claims = b64url(encoder.encode(JSON.stringify(body)));
  const data = `${head}.${claims}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

/**
 * Verifica firma y caducidad. Lanza `UnauthorizedException` en cualquier fallo — nunca devuelve un
 * payload a medio validar.
 *
 * La comprobación de firma va ANTES de mirar el contenido: `crypto.subtle.verify` compara en tiempo
 * constante, y parsear los claims de un token no verificado sería tratar como datos algo que aún es
 * entrada arbitraria.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedException('Token inválido o expirado.');
  const [head, claims, sig] = parts;

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(sig), encoder.encode(`${head}.${claims}`));
  } catch {
    throw new UnauthorizedException('Token inválido o expirado.');
  }
  if (!valid) throw new UnauthorizedException('Token inválido o expirado.');

  let payload: JwtPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(claims))) as JwtPayload;
  } catch {
    throw new UnauthorizedException('Token inválido o expirado.');
  }

  // Un token SIN `exp` no es un token de sesión válido: sin caducidad no habría forma de revocarlo.
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new UnauthorizedException('Token inválido o expirado.');
  }
  return payload;
}
