import { describe, it, expect } from 'vitest';
import { can } from './rbac.policy';

describe('RBAC (deny-by-default)', () => {
  it('OWNER tiene acceso total', () => {
    expect(can('OWNER', 'secret:read')).toBe(true);
    expect(can('OWNER', 'cualquier:cosa')).toBe(true);
  });

  it('ADMIN cubre recursos vía comodín pero no todo', () => {
    expect(can('ADMIN', 'workflow:delete')).toBe(true); // workflow:*
    expect(can('ADMIN', 'secret:read')).toBe(true);
    expect(can('ADMIN', 'secret:write')).toBe(false); // solo secret:read
  });

  it('EDITOR puede escribir workflows pero no borrar secretos', () => {
    expect(can('EDITOR', 'workflow:write')).toBe(true);
    expect(can('EDITOR', 'secret:read')).toBe(false);
    expect(can('EDITOR', 'workflow:delete')).toBe(false);
  });

  it('VIEWER solo lee', () => {
    expect(can('VIEWER', 'workflow:read')).toBe(true);
    expect(can('VIEWER', 'workflow:write')).toBe(false);
  });

  it('un scope desconocido se deniega', () => {
    expect(can('ADMIN', 'billing:charge')).toBe(false);
  });

  // Bloquea la regresión del bug M74: un VIEWER podía crear/editar por endpoints sin @RequireScopes.
  it('scopes exactos de los endpoints que mutan (M74)', () => {
    // VIEWER NO puede escribir NADA
    for (const s of ['workflow:write', 'agent:write', 'execution:create', 'connector:write', 'connector:delete', 'apikey:manage']) {
      expect(can('VIEWER', s)).toBe(false);
    }
    // EDITOR: autoría de flujos/agentes + lanzar ejecuciones… pero NO gestionar integraciones ni claves de IA
    expect(can('EDITOR', 'agent:write')).toBe(true);
    expect(can('EDITOR', 'agent:execute')).toBe(true);
    expect(can('EDITOR', 'execution:create')).toBe(true);
    expect(can('EDITOR', 'connector:write')).toBe(false);
    expect(can('EDITOR', 'connector:delete')).toBe(false);
    expect(can('EDITOR', 'apikey:manage')).toBe(false);
    // ADMIN sí gestiona conectores (connector:*) y claves de IA (apikey:manage)
    expect(can('ADMIN', 'connector:write')).toBe(true);
    expect(can('ADMIN', 'connector:delete')).toBe(true);
    expect(can('ADMIN', 'apikey:manage')).toBe(true);
  });
});
