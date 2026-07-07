import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@core/contracts';
import type { IApiKeyRepository } from '@core/engine';

export const API_KEY_PREFIX = 'af';

/** Principal resuelto desde una API key: misma forma que el payload de un JWT de sesión. */
export interface ApiKeyPrincipal {
  sub: string;
  email: string;
  role: Role;
  workspaceId: string;
}

/** Genera una clave nueva: `af_<32 bytes base64url>`. Devuelve la clave en claro + metadatos de display. */
export function generateRawKey(): { raw: string; prefix: string; last4: string } {
  const raw = `${API_KEY_PREFIX}_${randomBytes(32).toString('base64url')}`;
  return { raw, prefix: API_KEY_PREFIX, last4: raw.slice(-4) };
}

/** Hash de un solo sentido (sha256 hex). El lookup de autenticación es por este hash indexado. */
export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** ¿El bearer es una API key (`af_…`) y no un JWT de sesión? */
export function isApiKey(token: string): boolean {
  return token.startsWith(`${API_KEY_PREFIX}_`);
}

/**
 * Resuelve una clave en claro a un principal (o null si no existe / está revocada). Sella el último uso
 * best-effort (sin await). Compartido por el guard global (auth por cabecera) y el controller MCP (key en
 * la URL). NO lanza: devuelve null para que el llamante decida el 401.
 */
export async function resolveApiKey(repo: IApiKeyRepository, raw: string): Promise<ApiKeyPrincipal | null> {
  if (!isApiKey(raw)) return null;
  const rec = await repo.findByHash(hashKey(raw));
  if (!rec) return null;
  void repo.touchLastUsed(rec.id);
  return { sub: rec.userSub, email: rec.email, role: rec.role, workspaceId: rec.workspaceId };
}
