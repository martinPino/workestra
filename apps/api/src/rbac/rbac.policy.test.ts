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
});
