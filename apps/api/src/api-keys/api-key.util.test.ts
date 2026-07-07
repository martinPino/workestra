import { describe, it, expect } from 'vitest';
import type { IApiKeyRepository, ApiKeyRecord } from '@core/engine';
import { generateRawKey, hashKey, isApiKey, resolveApiKey } from './api-key.util';

describe('api-key util (M32)', () => {
  it('generateRawKey → af_… con prefix/last4 coherentes y aleatoria', () => {
    const { raw, prefix, last4 } = generateRawKey();
    expect(raw.startsWith('af_')).toBe(true);
    expect(prefix).toBe('af');
    expect(last4).toHaveLength(4);
    expect(raw.endsWith(last4)).toBe(true);
    expect(generateRawKey().raw).not.toBe(raw);
  });

  it('hashKey es estable, de un solo sentido y no filtra la clave', () => {
    expect(hashKey('af_abc')).toBe(hashKey('af_abc'));
    expect(hashKey('af_abc')).not.toBe(hashKey('af_abd'));
    expect(hashKey('af_abc')).not.toContain('af_abc');
    expect(hashKey('af_abc')).toHaveLength(64);
  });

  it('isApiKey distingue af_ de un JWT', () => {
    expect(isApiKey('af_xxx')).toBe(true);
    expect(isApiKey('eyJhbGciOiJI. signed.jwt')).toBe(false);
  });

  it('resolveApiKey → principal si activa; null si desconocida/no-key; sella el último uso', async () => {
    const { raw } = generateRawKey();
    const rec: ApiKeyRecord = {
      id: 'ak_1', workspaceId: 'ws_1', userSub: 'u1', email: 'a@b.c', role: 'ADMIN',
      hashedKey: hashKey(raw), prefix: 'af', last4: raw.slice(-4), label: 'x',
      createdAt: new Date(), lastUsedAt: null, revokedAt: null,
    };
    let touched = '';
    const repo: IApiKeyRepository = {
      create: async () => rec,
      findByHash: async (h) => (h === rec.hashedKey ? rec : null),
      listByWorkspace: async () => [rec],
      revoke: async () => rec,
      touchLastUsed: async (id) => { touched = id; },
    };
    expect(await resolveApiKey(repo, raw)).toEqual({ sub: 'u1', email: 'a@b.c', role: 'ADMIN', workspaceId: 'ws_1' });
    expect(touched).toBe('ak_1'); // best-effort touch del último uso
    expect(await resolveApiKey(repo, 'af_desconocida')).toBeNull();
    expect(await resolveApiKey(repo, 'no-es-una-key')).toBeNull();
  });
});
