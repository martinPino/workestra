import { create } from 'zustand';

export type Role = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';

/** Perfil de sesión del usuario autenticado (M73). Espejo del `SessionUser` del backend. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  workspaceId: string;
}

/**
 * Modo de autenticación del web (M73). En build de PRODUCCIÓN → 'local' (login+registro reales);
 * en `vite dev` → 'dev' (auto-sesión, sin fricción). Se puede forzar con VITE_AUTH_MODE.
 */
export const AUTH_MODE: 'local' | 'dev' =
  (import.meta.env.VITE_AUTH_MODE as 'local' | 'dev' | undefined) ?? (import.meta.env.PROD ? 'local' : 'dev');

/**
 * Sesión: guarda el JWT y el perfil del usuario. El token se inyecta como `Authorization: Bearer` en las
 * llamadas de negocio. Persistente en localStorage para sobrevivir recargas. `role`/`sub` se mantienen como
 * espejo del usuario para los consumidores existentes (RBAC de UX, aprobar revisiones, etc.).
 */
interface AuthState {
  token: string | null;
  user: SessionUser | null;
  role: Role | null;
  sub: string | null;
  /** Sesión real (login/registro): token + perfil completo. */
  setAuth: (s: { token: string; user: SessionUser }) => void;
  /** Compat: sesión de dev (minter) sin perfil completo. */
  setSession: (s: { token: string; role: Role; sub: string }) => void;
  clear: () => void;
}

const KEY = 'af.auth';

function load(): { token: string | null; user: SessionUser | null; role: Role | null; sub: string | null } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as { token?: string; user?: SessionUser; role?: Role; sub?: string };
      return { token: p.token ?? null, user: p.user ?? null, role: p.user?.role ?? p.role ?? null, sub: p.user?.id ?? p.sub ?? null };
    }
  } catch {
    /* ignore */
  }
  return { token: null, user: null, role: null, sub: null };
}

function persist(state: { token: string | null; user: SessionUser | null; role: Role | null; sub: string | null }): void {
  try {
    if (state.token) localStorage.setItem(KEY, JSON.stringify(state));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export const useAuth = create<AuthState>((set) => ({
  ...load(),
  setAuth: ({ token, user }) => {
    const next = { token, user, role: user.role, sub: user.id };
    persist(next);
    set(next);
  },
  setSession: ({ token, role, sub }) => {
    const next = { token, user: null, role, sub };
    persist(next);
    set(next);
  },
  clear: () => {
    persist({ token: null, user: null, role: null, sub: null });
    set({ token: null, user: null, role: null, sub: null });
  },
}));

/** Lectura sincrónica del token para el cliente API (fuera de React). */
export const currentToken = (): string | null => useAuth.getState().token;

/** ¿El JWT ya expiró? (decodifica el claim `exp`). Ante cualquier duda, lo trata como expirado. */
export function isExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1])) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 < Date.now() : true;
  } catch {
    return true;
  }
}

/** ¿Hay una sesión válida ahora mismo? (token presente y no caducado). */
export function hasValidSession(): boolean {
  const t = useAuth.getState().token;
  return !!t && !isExpired(t);
}

/**
 * Solo en modo 'dev': garantiza una sesión antes de renderizar acuñando un token OWNER (o re-acuñando
 * uno caducado) contra el minter de /auth/token. En 'local' esto NO se usa: la sesión la da el login real.
 */
export async function ensureDevSession(apiBase: string): Promise<void> {
  if (AUTH_MODE !== 'dev') return;
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
    if (!res.ok) return;
    const { accessToken } = (await res.json()) as { accessToken: string };
    useAuth.getState().setSession({ token: accessToken, role: wantRole, sub: wantSub });
  } catch {
    /* sin API: la app arranca sin sesión. */
  }
}

/** ¿El rol actual puede aprobar/rechazar revisiones? (espejo del RBAC del servidor, solo para UX). */
export function canApprove(role: Role | null): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'EDITOR';
}
