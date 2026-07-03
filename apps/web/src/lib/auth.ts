import { create } from 'zustand';

export type Role = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';

/**
 * Sesión de desarrollo: guarda el JWT emitido por POST /auth/token y el rol elegido. El token se
 * inyecta como `Authorization: Bearer` en las llamadas que exigen scopes (p. ej. aprobar una
 * revisión requiere `execution:approve`). Persistente en localStorage para sobrevivir recargas.
 */
interface AuthState {
  token: string | null;
  role: Role | null;
  sub: string | null;
  setSession: (s: { token: string; role: Role; sub: string }) => void;
  clear: () => void;
}

const KEY = 'af.auth';

function load(): { token: string | null; role: Role | null; sub: string | null } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { token: null, role: null, sub: null };
}

export const useAuth = create<AuthState>((set) => ({
  ...load(),
  setSession: ({ token, role, sub }) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ token, role, sub }));
    } catch {
      /* ignore */
    }
    set({ token, role, sub });
  },
  clear: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    set({ token: null, role: null, sub: null });
  },
}));

/** Lectura sincrónica del token para el cliente API (fuera de React). */
export const currentToken = (): string | null => useAuth.getState().token;

/** ¿El JWT ya expiró? (decodifica el claim `exp`). Ante cualquier duda, lo trata como expirado. */
function isExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1])) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 < Date.now() : true;
  } catch {
    return true;
  }
}

/**
 * Garantiza una sesión de DESARROLLO antes de renderizar: si no hay token o está caducado, acuña uno
 * nuevo (preservando el rol elegido, o OWNER por defecto) para que la app funcione autenticada —el
 * backend exige JWT en todas las rutas de negocio (M8)—. En producción esto lo sustituye el login OIDC.
 */
export async function ensureDevSession(apiBase: string): Promise<void> {
  const { token, role, sub } = useAuth.getState();
  if (token && !isExpired(token)) return;
  const wantRole: Role = role ?? 'OWNER';
  const wantSub = sub ?? `user_${wantRole.toLowerCase()}`;
  try {
    const res = await fetch(`${apiBase}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: wantRole, sub: wantSub }),
    });
    const { accessToken } = (await res.json()) as { accessToken: string };
    useAuth.getState().setSession({ token: accessToken, role: wantRole, sub: wantSub });
  } catch {
    /* sin API: la app arranca sin sesión; el usuario puede generar un token en Settings. */
  }
}

/** ¿El rol actual puede aprobar/rechazar revisiones? (espejo del RBAC del servidor, solo para UX). */
export function canApprove(role: Role | null): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'EDITOR';
}
