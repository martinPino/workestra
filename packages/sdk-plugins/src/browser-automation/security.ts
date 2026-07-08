/**
 * Política de SEGURIDAD del navegador (M71): impide navegar a dominios prohibidos, limita la vida de una
 * sesión y el nº de acciones. El cierre de procesos huérfanos y los límites de memoria los aplica el gestor
 * de sesiones + el motor real (fase de infra). La política se configura por env y por defecto es permisiva
 * salvo un denylist mínimo de destinos locales/metadata (SSRF).
 */
export interface BrowserSecurityPolicy {
  /** Si no está vacío, SOLO se permite navegar a estos hosts (allowlist). */
  allowHosts: string[];
  /** Hosts siempre prohibidos (denylist), aunque estén en el allowlist. */
  denyHosts: string[];
  /** Vida máxima de una sesión, en ms (se cierra al superarla). */
  maxSessionMs: number;
  /** Nº máximo de acciones por sesión. */
  maxActionsPerSession: number;
}

/**
 * Suelo DURO anti-SSRF: destinos internos/metadata SIEMPRE bloqueados, aunque la política de un workspace
 * traiga un denylist vacío. Evita que un agente navegue a la red interna del despliegue o a los endpoints de
 * metadatos del cloud.
 */
const HARD_DENY = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', 'metadata.google.internal'];

export function defaultSecurityPolicy(): BrowserSecurityPolicy {
  const csv = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    allowHosts: csv(process.env.BROWSER_ALLOW_HOSTS),
    denyHosts: csv(process.env.BROWSER_DENY_HOSTS),
    maxSessionMs: Math.max(5_000, Number(process.env.BROWSER_MAX_SESSION_MS ?? 120_000) || 120_000),
    maxActionsPerSession: Math.max(1, Number(process.env.BROWSER_MAX_ACTIONS ?? 200) || 200),
  };
}

/** Valida que se puede navegar a `url` bajo la política. Devuelve el motivo si NO se permite. */
export function checkNavigation(url: string, policy: BrowserSecurityPolicy): { ok: boolean; reason?: string } {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: `URL inválida: ${url}` };
  }
  const matches = (h: string) => host === h || host.endsWith(`.${h}`);
  // El suelo anti-SSRF se aplica SIEMPRE, además del denylist configurado.
  if (HARD_DENY.some(matches) || policy.denyHosts.some(matches)) {
    return { ok: false, reason: `Dominio prohibido: ${host}` };
  }
  if (policy.allowHosts.length > 0 && !policy.allowHosts.some(matches)) {
    return { ok: false, reason: `Dominio fuera del allowlist: ${host}` };
  }
  return { ok: true };
}
