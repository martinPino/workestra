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

  it('Slack ok:false (p. ej. missing_scope) → [] (cae al texto manual)', async () => {
    const res = await listSlackChannels({ token: 't', fetchFn: async () => ({ ok: true, json: async () => ({ ok: false, error: 'missing_scope' }) }) });
    expect(res.channels).toEqual([]);
  });

  it('error HTTP → []', async () => {
    const res = await listSlackChannels({ token: 't', fetchFn: async () => ({ ok: false, json: async () => ({}) }) });
    expect(res.channels).toEqual([]);
  });
});
