import type { Role } from './enums';

/**
 * RBAC mínimo viable (M0), compartido: roles fijos + scopes por recurso, DENY-BY-DEFAULT.
 * Vive en contracts para que tanto la API como el runtime de agentes (autorización de tools)
 * consuman la MISMA política, no stubs separados.
 * `resource:*` cubre cualquier acción de ese recurso; `*` es acceso total (OWNER).
 */
export const ROLE_SCOPES: Record<Role, string[]> = {
  OWNER: ['*'],
  ADMIN: ['workspace:*', 'workflow:*', 'agent:*', 'execution:*', 'connector:*', 'tool:*', 'secret:read', 'plugin:*'],
  EDITOR: [
    'workflow:read',
    'workflow:write',
    'agent:read',
    'agent:write',
    'agent:execute',
    'execution:read',
    'execution:create',
    'execution:approve',
    'tool:read',
    'tool:mock',
    'tool:http',
    'connector:read',
  ],
  VIEWER: ['workflow:read', 'agent:read', 'execution:read', 'tool:read', 'connector:read'],
};

/** Devuelve true solo si el rol tiene el scope (o su comodín). Desconocido => false. */
export function can(role: Role, scope: string): boolean {
  const scopes = ROLE_SCOPES[role];
  if (!scopes) return false;
  if (scopes.includes('*')) return true;
  if (scopes.includes(scope)) return true;
  const resource = scope.split(':')[0];
  return resource ? scopes.includes(`${resource}:*`) : false;
}
