import { describe, it, expect } from 'vitest';
import type { IConnectorRepository, ISecretStore, ConnectorRecord } from '@core/engine';
import type { McpServerRef } from '@core/contracts';
import { getIntegration, integrationKeyFromUrl, integrationUrl, INTEGRATIONS } from './integrations';
import { IntegrationToolResolver, composeMcpResolvers } from './integration-tool-resolver';
import type { JiraFetch } from './jira-webhooks';

// --- Stubs mínimos --------------------------------------------------------------------------------

function connectorRepo(records: ConnectorRecord[]): IConnectorRepository {
  return {
    create: async () => records[0],
    getInWorkspace: async (id, ws) => records.find((c) => c.id === id && c.workspaceId === ws) ?? null,
    listByWorkspace: async (ws) => records.filter((c) => c.workspaceId === ws),
    setConnected: async () => undefined,
    delete: async () => null,
  };
}

function secretStore(map: Record<string, string>): ISecretStore {
  return {
    set: async () => undefined,
    get: async (_ws, key) => map[key] ?? null,
    list: async () => Object.keys(map),
    delete: async () => undefined,
  };
}

const CONNECTED: ConnectorRecord = {
  id: 'conn-1',
  workspaceId: 'ws-1',
  key: 'atlassian-1',
  provider: 'jira',
  status: 'connected',
  credentialsSecretId: 'connector:conn-1:oauth',
};

/** fetch que enruta por URL y registra las llamadas; accessible-resources devuelve un cloudId. */
function makeFetch(routes: Record<string, { ok?: boolean; status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fetchFn: JiraFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/oauth/token/accessible-resources')) {
      return { ok: true, status: 200, json: async () => [{ id: 'cloud-XYZ', url: 'https://x.atlassian.net', name: 'X' }] };
    }
    for (const [frag, r] of Object.entries(routes)) {
      if (url.includes(frag)) return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body ?? {} };
    }
    return { ok: false, status: 404, json: async () => ({ message: 'no route' }) };
  };
  return { fetchFn, calls };
}

const serversFor = (key: string): McpServerRef[] => [{ id: 's1', name: 'Atlassian', url: integrationUrl(key) }];

// --- Registro -------------------------------------------------------------------------------------

describe('integrations registry (M76)', () => {
  it('integrationKeyFromUrl parsea solo integration://', () => {
    expect(integrationKeyFromUrl('integration://atlassian')).toBe('atlassian');
    expect(integrationKeyFromUrl('integration://atlassian/')).toBe('atlassian');
    expect(integrationKeyFromUrl('https://mcp.atlassian.com/v1/sse')).toBeNull();
    expect(integrationKeyFromUrl('')).toBeNull();
  });

  it('atlassian expone herramientas de Jira y Confluence', () => {
    const def = getIntegration('atlassian')!;
    expect(def.provider).toBe('jira');
    const names = def.tools.map((t) => t.name);
    expect(names).toContain('jira_search_issues');
    expect(names).toContain('jira_create_issue');
    expect(names).toContain('confluence_create_page');
  });

  it('todas las herramientas tienen esquema JSON válido y nombre saneado', () => {
    for (const def of Object.values(INTEGRATIONS)) {
      for (const t of def.tools) {
        expect(t.name).toMatch(/^[a-z0-9_]+$/);
        expect((t.parameters as { type?: string }).type).toBe('object');
      }
    }
  });
});

// --- Resolver -------------------------------------------------------------------------------------

describe('IntegrationToolResolver (M76)', () => {
  it('conector conectado → devuelve McpTool[] con el cloudId resuelto', async () => {
    const { fetchFn } = makeFetch({});
    const resolver = new IntegrationToolResolver(connectorRepo([CONNECTED]), secretStore({ 'connector:conn-1:oauth': 'tok-123' }), fetchFn);
    const tools = await resolver.resolve('ws-1', serversFor('atlassian'));
    expect(tools.map((t) => t.name)).toContain('jira_search_issues');
    expect(tools.length).toBe(getIntegration('atlassian')!.tools.length);
  });

  it('NO filtra el token al modelo: no aparece en nombre/descripcion/parametros', async () => {
    const { fetchFn } = makeFetch({});
    const resolver = new IntegrationToolResolver(connectorRepo([CONNECTED]), secretStore({ 'connector:conn-1:oauth': 'tok-SECRET' }), fetchFn);
    const tools = await resolver.resolve('ws-1', serversFor('atlassian'));
    const surface = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
    expect(surface).not.toContain('tok-SECRET');
  });

  it('sin conector conectado → sin herramientas (la UI pedirá conectar)', async () => {
    const disconnected: ConnectorRecord = { ...CONNECTED, status: 'disconnected', credentialsSecretId: null };
    const { fetchFn } = makeFetch({});
    const resolver = new IntegrationToolResolver(connectorRepo([disconnected]), secretStore({}), fetchFn);
    expect(await resolver.resolve('ws-1', serversFor('atlassian'))).toEqual([]);
  });

  it('ignora refs http(s):// (las resuelve el resolver MCP HTTP, no este)', async () => {
    const { fetchFn } = makeFetch({});
    const resolver = new IntegrationToolResolver(connectorRepo([CONNECTED]), secretStore({ 'connector:conn-1:oauth': 'tok-123' }), fetchFn);
    const tools = await resolver.resolve('ws-1', [{ id: 's', name: 'X', url: 'https://mcp.example.com/sse' }]);
    expect(tools).toEqual([]);
  });

  it('jira_create_issue: llama al endpoint correcto con Bearer y parsea la clave', async () => {
    const { fetchFn, calls } = makeFetch({ '/rest/api/3/issue': { body: { id: '10001', key: 'KAN-1' } } });
    const resolver = new IntegrationToolResolver(connectorRepo([CONNECTED]), secretStore({ 'connector:conn-1:oauth': 'tok-123' }), fetchFn);
    const tools = await resolver.resolve('ws-1', serversFor('atlassian'));
    const create = tools.find((t) => t.name === 'jira_create_issue')!;
    const out = (await create.invoke({ projectKey: 'KAN', summary: 'Hola' })) as { created: boolean; key: string };
    expect(out).toEqual({ created: true, key: 'KAN-1', id: '10001' });
    const call = calls.find((c) => c.url.includes('/ex/jira/cloud-XYZ/rest/api/3/issue'))!;
    expect(call.init?.method).toBe('POST');
    expect(call.init?.headers?.authorization).toBe('Bearer tok-123');
    expect(JSON.parse(call.init!.body!)).toMatchObject({ fields: { project: { key: 'KAN' }, summary: 'Hola' } });
  });

  it('confluence_search: convierte query a CQL text ~', async () => {
    const { fetchFn, calls } = makeFetch({ '/wiki/rest/api/search': { body: { results: [{ content: { id: '99', type: 'page', title: 'Doc' } }] } } });
    const resolver = new IntegrationToolResolver(connectorRepo([CONNECTED]), secretStore({ 'connector:conn-1:oauth': 'tok-123' }), fetchFn);
    const tools = await resolver.resolve('ws-1', serversFor('atlassian'));
    const search = tools.find((t) => t.name === 'confluence_search')!;
    const out = (await search.invoke({ query: 'roadmap' })) as { results: unknown[] };
    expect(out.results).toHaveLength(1);
    const call = calls.find((c) => c.url.includes('/wiki/rest/api/search'))!;
    expect(decodeURIComponent(call.url)).toContain('text ~ "roadmap"');
  });
});

// --- Composición ----------------------------------------------------------------------------------

describe('composeMcpResolvers (M76)', () => {
  it('concatena resultados de varios resolvers y omite los undefined', async () => {
    const a = { resolve: async () => [{ name: 'a', description: '', parameters: {}, invoke: async () => 1 }] };
    const b = { resolve: async () => [{ name: 'b', description: '', parameters: {}, invoke: async () => 2 }] };
    const composed = composeMcpResolvers(a, undefined, b)!;
    const tools = await composed.resolve('ws-1', []);
    expect(tools.map((t) => t.name).sort()).toEqual(['a', 'b']);
  });

  it('un solo resolver → se devuelve tal cual; ninguno → undefined', async () => {
    const a = { resolve: async () => [] };
    expect(composeMcpResolvers(a)).toBe(a);
    expect(composeMcpResolvers(undefined, undefined)).toBeUndefined();
  });
});
