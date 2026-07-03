import { describe, it, expect } from 'vitest';
import { ToolAuthorizationService } from './tool-authorization';

describe('ToolAuthorizationService (deny-by-default, consume el RBAC de M0)', () => {
  const authz = new ToolAuthorizationService();

  it('permite una tool del allowlist si el rol tiene el scope RBAC', () => {
    expect(authz.authorize({ role: 'EDITOR', agentTools: ['http'], toolKey: 'http' }).allowed).toBe(true);
    expect(authz.authorize({ role: 'ADMIN', agentTools: ['mock'], toolKey: 'mock' }).allowed).toBe(true);
    expect(authz.authorize({ role: 'OWNER', agentTools: ['http'], toolKey: 'http' }).allowed).toBe(true);
  });

  it('deniega si la tool no está en el allowlist del agente', () => {
    expect(authz.authorize({ role: 'ADMIN', agentTools: ['mock'], toolKey: 'http' }).allowed).toBe(false);
  });

  it('deniega por RBAC aunque esté en el allowlist (VIEWER no tiene tool:http)', () => {
    const r = authz.authorize({ role: 'VIEWER', agentTools: ['http'], toolKey: 'http' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('scope');
  });

  it('deniega tools fuera del catálogo seguro (p.ej. shell)', () => {
    expect(authz.authorize({ role: 'OWNER', agentTools: ['shell'], toolKey: 'shell' }).allowed).toBe(false);
  });
});
