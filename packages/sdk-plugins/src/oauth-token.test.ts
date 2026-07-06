import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseTokenBlob,
  serializeTokenBlob,
  tokenBlobFromResponse,
  needsRefresh,
  refreshAccessToken,
  providerClientCreds,
} from './oauth-token';

describe('oauth-token (M28)', () => {
  it('parseTokenBlob: string suelto legacy → solo access_token', () => {
    expect(parseTokenBlob('xoxb-abc')).toEqual({ access_token: 'xoxb-abc' });
  });

  it('parseTokenBlob: blob JSON completo', () => {
    const raw = JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 123 });
    expect(parseTokenBlob(raw)).toEqual({ access_token: 'a', refresh_token: 'r', expires_at: 123 });
  });

  it('parseTokenBlob: JSON inválido cae con gracia a string suelto', () => {
    expect(parseTokenBlob('{no es json')).toEqual({ access_token: '{no es json' });
  });

  it('serializeTokenBlob: sin refresh/expiry → string suelto (compat con lectores legacy)', () => {
    expect(serializeTokenBlob({ access_token: 'a' })).toBe('a');
  });

  it('serializeTokenBlob: con refresh → JSON (ida y vuelta)', () => {
    const s = serializeTokenBlob({ access_token: 'a', refresh_token: 'r', expires_at: 5 });
    expect(parseTokenBlob(s)).toEqual({ access_token: 'a', refresh_token: 'r', expires_at: 5 });
  });

  it('tokenBlobFromResponse calcula expires_at desde expires_in', () => {
    expect(tokenBlobFromResponse({ refresh_token: 'r', expires_in: 3600 }, 'a', 1000)).toEqual({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: 1000 + 3600 * 1000,
    });
  });

  it('needsRefresh: caducado+refresh → true; sin refresh o no caducado → false', () => {
    expect(needsRefresh({ access_token: 'a', refresh_token: 'r', expires_at: 100 }, 200)).toBe(true);
    expect(needsRefresh({ access_token: 'a', expires_at: 100 }, 200)).toBe(false);
    expect(needsRefresh({ access_token: 'a', refresh_token: 'r', expires_at: 10_000_000 }, 200)).toBe(false);
  });

  describe('providerClientCreds / refreshAccessToken', () => {
    afterEach(() => {
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
    });

    it('providerClientCreds resuelve configProvider (gmail → GOOGLE_*)', () => {
      expect(providerClientCreds('gmail')).toBeNull();
      process.env.GOOGLE_CLIENT_ID = 'cid';
      process.env.GOOGLE_CLIENT_SECRET = 'sec';
      expect(providerClientCreds('gmail')).toEqual({ clientId: 'cid', clientSecret: 'sec' });
    });

    it('sin credenciales del cliente → null (no intenta renovar)', async () => {
      const r = await refreshAccessToken('gmail', { access_token: 'a', refresh_token: 'r' }, 0, async () => ({ ok: true, json: async () => ({}) }));
      expect(r).toBeNull();
    });

    it('renueva con el refresh y conserva el refresh anterior (Google no manda uno nuevo)', async () => {
      process.env.GOOGLE_CLIENT_ID = 'cid';
      process.env.GOOGLE_CLIENT_SECRET = 'sec';
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'nuevo', expires_in: 3600 }) }));
      const r = await refreshAccessToken('gmail', { access_token: 'viejo', refresh_token: 'r' }, 1000, fetchMock);
      expect(r?.access_token).toBe('nuevo');
      expect(r?.refresh_token).toBe('r');
      expect(r?.expires_at).toBe(1000 + 3600 * 1000);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
      expect(url).toBe('https://oauth2.googleapis.com/token');
      expect(String(init.body)).toContain('grant_type=refresh_token');
    });

    it('respuesta no-ok → null (best-effort, se usa el token actual)', async () => {
      process.env.GOOGLE_CLIENT_ID = 'cid';
      process.env.GOOGLE_CLIENT_SECRET = 'sec';
      const r = await refreshAccessToken('gmail', { access_token: 'a', refresh_token: 'r' }, 0, async () => ({ ok: false, json: async () => ({}) }));
      expect(r).toBeNull();
    });
  });
});
