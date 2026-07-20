import type { Role } from './enums';

/**
 * RBAC mínimo viable (M0), compartido: roles fijos + scopes por recurso, DENY-BY-DEFAULT.
 * Vive en contracts para que tanto la API como el runtime de agentes (autorización de tools)
 * consuman la MISMA política, no stubs separados.
 * `resource:*` cubre cualquier acción de ese recurso; `*` es acceso total (OWNER).
 */
export const ROLE_SCOPES: Record<Role, string[]> = {
  OWNER: ['*'],
  // M84: `analytics:read` es de OWNER/ADMIN. No se hereda de `workspace:*`: son datos de navegación
  // POR PERSONA, así que darlos a EDITOR/VIEWER sería vigilar a los compañeros.
  ADMIN: ['workspace:*', 'workflow:*', 'agent:*', 'execution:*', 'connector:*', 'integration:*', 'tool:*', 'secret:read', 'plugin:*', 'apikey:manage', 'team:manage', 'analytics:read'],
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
    'tool:browser',
    'connector:read',
    // M76: usar integraciones de primera clase (Atlassian…) desde un agente. `connector:*` (conectar el
    // OAuth) sigue siendo solo de ADMIN; esto es solo USAR lo ya conectado, como los nodos de conector.
    'integration:read',
    'integration:write',
  ],
  VIEWER: ['workflow:read', 'agent:read', 'execution:read', 'tool:read', 'connector:read', 'integration:read'],
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
