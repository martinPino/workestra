import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthAccount } from '@core/engine';
import { hashKey } from '../api-keys/api-key.util';
import type { PersistenceBundle } from '../persistence/bundle';
import { authMiddleware, __resetStatusCache, type AuthVariables } from './auth.middleware';
import { requireScopes } from './scopes.middleware';
import { toErrorResponse } from './errors';
import { signJwt } from './jwt';

const SECRET = 'secreto-de-pruebas';

const account = (over: Partial<AuthAccount> = {}): AuthAccount => ({
  id: 'u_1',
  email: 'a@b.dev',
  name: 'A',
  passwordHash: 'x',
  workspaceId: 'ws_1',
  organizationId: 'org_1',
  role: 'OWNER',
  disabledAt: null,
  ...over,
});

/** Bundle mínimo: el middleware solo toca `auth` y `apiKeys`. */
function fakePersistence(opts: {
  findByEmail?: (email: string) => Promise<AuthAccount | null>;
  keys?: Array<{ hashedKey: string; userSub: string; email: string; role: 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER'; workspaceId: string }>;
}): PersistenceBundle {
  return {
    auth: { findByEmail: opts.findByEmail ?? (async () => account()) },
    apiKeys: {
      findByHash: async (h: string) => opts.keys?.find((k) => k.hashedKey === h) ?? null,
      touchLastUsed: async () => {},
    },
  } as unknown as PersistenceBundle;
}

/** App de prueba: una ruta protegida y otra pública, con el mismo cableado que el Worker real. */
function app(persistence: PersistenceBundle, scopes: string[] = []) {
  const a = new Hono<{ Variables: AuthVariables }>();
  a.onError((err) => {
    const { status, body } = toErrorResponse(err);
    return Response.json(body, { status });
  });
  a.use('*', async (c, next) => {
    c.set('persistence', persistence);
    return next();
  });
  a.use('*', authMiddleware(SECRET));
  a.get('/health', (c) => c.json({ ok: true }));
  a.get('/agents', requireScopes(...scopes), (c) => c.json({ user: c.get('user') }));
  return a;
}

const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

beforeEach(() => __resetStatusCache());

describe('authMiddleware — credenciales', () => {
  it('deja pasar una ruta pública sin credencial', async () => {
    const res = await app(fakePersistence({})).request('/health');
    expect(res.status).toBe(200);
  });

  it('exige Bearer en una ruta protegida', async () => {
    const res = await app(fakePersistence({})).request('/agents');
    expect(res.status).toBe(401);
    expect((await res.json()).message).toMatch(/Bearer/);
  });

  it('acepta un JWT de sesión y expone el principal', async () => {
    const token = await signJwt({ sub: 'u_1', email: 'a@b.dev', role: 'OWNER', workspaceId: 'ws_1' }, SECRET);
    const res = await app(fakePersistence({})).request('/agents', bearer(token));
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ sub: 'u_1', workspaceId: 'ws_1', role: 'OWNER' });
  });

  it('rechaza un token firmado con otro secreto', async () => {
    const token = await signJwt({ sub: 'u_1', email: 'a@b.dev', role: 'OWNER', workspaceId: 'ws_1' }, 'otro');
    expect((await app(fakePersistence({})).request('/agents', bearer(token))).status).toBe(401);
  });

  it('rechaza un token que NO es de sesión aunque la firma sea válida', async () => {
    // El `oauth_state` de conectores se firma con el MISMO secreto. Sin esta comprobación, valdría
    // como sesión: quien pudiera provocar uno entraría al API con él.
    const token = await signJwt(
      { sub: 'u_1', email: 'a@b.dev', role: 'OWNER', workspaceId: 'ws_1', kind: 'oauth_state' },
      SECRET,
    );
    const res = await app(fakePersistence({})).request('/agents', bearer(token));
    expect(res.status).toBe(401);
    expect((await res.json()).message).toMatch(/no válido para sesión/);
  });

  it('acepta una API key y la resuelve al mismo principal que un JWT', async () => {
    const raw = 'af_una-clave-de-pruebas';
    const p = fakePersistence({
      keys: [{ hashedKey: hashKey(raw), userSub: 'u_9', email: 'a@b.dev', role: 'EDITOR', workspaceId: 'ws_9' }],
      findByEmail: async () => account({ role: 'EDITOR', workspaceId: 'ws_9' }),
    });
    const res = await app(p).request('/agents', bearer(raw));
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ sub: 'u_9', workspaceId: 'ws_9', role: 'EDITOR' });
  });

  it('rechaza una API key inexistente o revocada', async () => {
    const res = await app(fakePersistence({ keys: [] })).request('/agents', bearer('af_no-existe'));
    expect(res.status).toBe(401);
    expect((await res.json()).message).toMatch(/API key/);
  });
});

describe('authMiddleware — revalidación de cuenta (M74)', () => {
  it('rechaza a un usuario cuya cuenta se cerró, aunque su JWT siga vigente', async () => {
    const token = await signJwt({ sub: 'u_1', email: 'a@b.dev', role: 'OWNER', workspaceId: 'ws_1' }, SECRET);
    const p = fakePersistence({ findByEmail: async () => account({ disabledAt: new Date() }) });
    const res = await app(p).request('/agents', bearer(token));
    expect(res.status).toBe(401);
    expect((await res.json()).message).toMatch(/desactivada/);
  });

  it('una API key deja de funcionar si su dueño fue cerrado (offboarding)', async () => {
    const raw = 'af_clave-de-alguien-cerrado';
    const p = fakePersistence({
      keys: [{ hashedKey: hashKey(raw), userSub: 'u_9', email: 'a@b.dev', role: 'OWNER', workspaceId: 'ws_9' }],
      findByEmail: async () => account({ disabledAt: new Date() }),
    });
    expect((await app(p).request('/agents', bearer(raw))).status).toBe(401);
  });

  it('el rol de la BD MANDA sobre el del token (degradar surte efecto sin re-login)', async () => {
    // El JWT dice OWNER; la BD dice VIEWER. Si ganase el token, degradar a alguien no haría nada
    // durante los 7 días de vida de su sesión.
    const token = await signJwt({ sub: 'u_1', email: 'a@b.dev', role: 'OWNER', workspaceId: 'ws_1' }, SECRET);
    const p = fakePersistence({ findByEmail: async () => account({ role: 'VIEWER' }) });
    const res = await app(p, ['agent:write']).request('/agents', bearer(token));
    expect(res.status).toBe(403);
  });

  it('hace FAIL-OPEN si la BD falla: cae al token en vez de tumbar la auth entera', async () => {
    const token = await signJwt({ sub: 'u_1', email: 'a@b.dev', role: 'OWNER', workspaceId: 'ws_1' }, SECRET);
    const p = fakePersistence({
      findByEmail: async () => {
        throw new Error('conexión caída');
      },
    });
    const res = await app(p).request('/agents', bearer(token));
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ role: 'OWNER' });
  });
});

describe('requireScopes', () => {
  it('deja pasar a quien tiene el scope', async () => {
    const token = await signJwt({ sub: 'u_1', email: 'a@b.dev', role: 'OWNER', workspaceId: 'ws_1' }, SECRET);
    const res = await app(fakePersistence({}), ['agent:write']).request('/agents', bearer(token));
    expect(res.status).toBe(200);
  });

  it('deniega a quien no lo tiene', async () => {
    const token = await signJwt({ sub: 'u_1', email: 'a@b.dev', role: 'VIEWER', workspaceId: 'ws_1' }, SECRET);
    const p = fakePersistence({ findByEmail: async () => account({ role: 'VIEWER' }) });
    const res = await app(p, ['agent:write']).request('/agents', bearer(token));
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/agent:write/);
  });
});
