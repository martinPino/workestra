import { describe, it, expect } from 'vitest';
import { listSlackChannels } from './slack-api';

describe('listSlackChannels', () => {
  it('pide canales públicos+privados no archivados con el bot token y ordena por nombre', async () => {
    const res = await listSlackChannels({
      token: 'xoxb-tok',
      fetchFn: async (url, init) => {
        expect(url).toContain('conversations.list');
        expect(url).toContain('exclude_archived=true');
        expect(init?.headers?.authorization).toBe('Bearer xoxb-tok');
        return { ok: true, json: async () => ({ ok: true, channels: [{ id: 'C2', name: 'sozial' }, { id: 'C1', name: 'general' }] }) };
      },
    });
    expect(res.channels).toEqual([{ id: 'C1', name: 'general' }, { id: 'C2', name: 'sozial' }]);
  });

  it('descarta filas incompletas', async () => {
    const res = await listSlackChannels({ token: 't', fetchFn: async () => ({ ok: true, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'ok' }, { id: '', name: 'x' }, { name: 'sin-id' }] }) }) });
    expect(res.channels).toEqual([{ id: 'C1', name: 'ok' }]);
  });

  it('sin groups:read: la 1ª llamada (con privados) da missing_scope → REINTENTA solo con públicos', async () => {
    const urls: string[] = [];
    const res = await listSlackChannels({
      token: 't',
      fetchFn: async (url) => {
        urls.push(url);
        if (url.includes('private_channel')) return { ok: true, json: async () => ({ ok: false, error: 'missing_scope' }) };
        return { ok: true, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'general' }] }) };
      },
    });
    expect(urls[0]).toContain('public_channel,private_channel'); // primero pide ambos
    expect(urls[1]).toContain('types=public_channel&'); // fallback: solo públicos
    expect(res.channels).toEqual([{ id: 'C1', name: 'general' }]);
  });

  it('con groups:read: la 1ª llamada trae públicos + privados (sin reintento)', async () => {
    let calls = 0;
    const res = await listSlackChannels({
      token: 't',
      fetchFn: async () => {
        calls++;
        return { ok: true, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'general' }, { id: 'C2', name: 'privado' }] }) };
      },
    });
    expect(calls).toBe(1);
    expect(res.channels.map((c) => c.id)).toEqual(['C1', 'C2']);
  });

  it('otro error de Slack (no missing_scope) → [] sin reintentar', async () => {
    let calls = 0;
    const res = await listSlackChannels({ token: 't', fetchFn: async () => { calls++; return { ok: true, json: async () => ({ ok: false, error: 'invalid_auth' }) }; } });
    expect(calls).toBe(1);
    expect(res.channels).toEqual([]);
  });

  it('error HTTP → []', async () => {
    const res = await listSlackChannels({ token: 't', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
    expect(res.channels).toEqual([]);
  });
});
