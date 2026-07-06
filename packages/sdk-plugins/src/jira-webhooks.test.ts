import { describe, it, expect } from 'vitest';
import {
  jiraAccessibleResources,
  listJiraProjects,
  registerJiraWebhook,
  deleteJiraWebhooks,
  refreshJiraWebhooks,
  type JiraFetch,
} from './jira-webhooks';

/** Stub de fetch que registra las llamadas y devuelve respuestas predefinidas por URL/método. */
function stubFetch(
  handler: (url: string, init?: { method?: string; body?: string }) => { ok?: boolean; status?: number; json?: unknown },
): { fetch: JiraFetch; calls: Array<{ url: string; method: string; body?: unknown }> } {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetch: JiraFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    const r = handler(url, init);
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json ?? {} };
  };
  return { fetch, calls };
}

describe('jira-webhooks', () => {
  it('resuelve los sitios accesibles (cloudId)', async () => {
    const { fetch, calls } = stubFetch(() => ({
      json: [{ id: 'cloud-123', url: 'https://acme.atlassian.net', name: 'Acme' }],
    }));
    const sites = await jiraAccessibleResources('tok', fetch);
    expect(sites).toEqual([{ id: 'cloud-123', url: 'https://acme.atlassian.net', name: 'Acme' }]);
    expect(calls[0].url).toBe('https://api.atlassian.com/oauth/token/accessible-resources');
  });

  it('lista proyectos del sitio (para el desplegable del picker)', async () => {
    const { fetch, calls } = stubFetch(() => ({
      json: { values: [{ key: 'KAN', name: 'Kanban', extra: 1 }, { key: 'OPS', name: 'Ops' }] },
    }));
    const projects = await listJiraProjects('tok', 'cloud-123', fetch);
    expect(projects).toEqual([{ key: 'KAN', name: 'Kanban' }, { key: 'OPS', name: 'Ops' }]);
    expect(calls[0].url).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/project/search');
  });

  it('registra un webhook y devuelve el id creado, con el body correcto', async () => {
    const { fetch, calls } = stubFetch(() => ({
      json: { webhookRegistrationResult: [{ createdWebhookId: 42 }] },
    }));
    const ids = await registerJiraWebhook(
      'tok',
      'cloud-123',
      { url: 'https://api.example.com/hooks/wh1?token=secret', events: ['jira:issue_created'], jqlFilter: 'project = KAN' },
      fetch,
    );
    expect(ids).toEqual([42]);
    // URL y método
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/webhook');
    // Forma del body: url top-level + webhooks[{ events, jqlFilter }]
    expect(calls[0].body).toEqual({
      url: 'https://api.example.com/hooks/wh1?token=secret',
      webhooks: [{ events: ['jira:issue_created'], jqlFilter: 'project = KAN' }],
    });
  });

  it('lanza si el registro no devuelve id (con los errores de Jira)', async () => {
    const { fetch } = stubFetch(() => ({
      json: { webhookRegistrationResult: [{ errors: ['jqlFilter no válido'] }] },
    }));
    await expect(
      registerJiraWebhook('tok', 'c', { url: 'u', events: ['jira:issue_created'], jqlFilter: 'bad' }, fetch),
    ).rejects.toThrow(/jqlFilter no válido/);
  });

  it('lanza en HTTP de error del registro', async () => {
    const { fetch } = stubFetch(() => ({ ok: false, status: 403, json: { message: 'forbidden' } }));
    await expect(
      registerJiraWebhook('tok', 'c', { url: 'u', events: ['jira:issue_created'], jqlFilter: 'project = KAN' }, fetch),
    ).rejects.toThrow(/HTTP 403/);
  });

  it('borra webhooks por id con el body { webhookIds }', async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 202 }));
    await deleteJiraWebhooks('tok', 'cloud-123', [42, 43], fetch);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/webhook');
    expect(calls[0].body).toEqual({ webhookIds: [42, 43] });
  });

  it('no llama a la API si no hay ids que borrar/renovar', async () => {
    const { fetch, calls } = stubFetch(() => ({}));
    await deleteJiraWebhooks('tok', 'c', [], fetch);
    await refreshJiraWebhooks('tok', 'c', [], fetch);
    expect(calls).toHaveLength(0);
  });

  it('renueva webhooks con PUT …/webhook/refresh', async () => {
    const { fetch, calls } = stubFetch(() => ({ json: {} }));
    await refreshJiraWebhooks('tok', 'cloud-123', [42], fetch);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/webhook/refresh');
    expect(calls[0].body).toEqual({ webhookIds: [42] });
  });
});
