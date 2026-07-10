/**
 * Resolver de INTEGRACIONES (M76): convierte las refs `integration://<key>` de `agent.mcpServers` en
 * herramientas invocables, SIN que el agente vea el OAuth. Para cada integración: localiza el conector OAuth
 * CONECTADO del workspace (por `provider`), resuelve/renueva su access token (mismo camino que los nodos de
 * conector), resuelve el cloudId de Atlassian y envuelve cada capacidad como `McpTool` con el token inyectado
 * en el `invoke`. Implementa el MISMO puerto `IMcpToolResolver`, así que se ofrece al modelo junto a las
 * herramientas MCP y builtin, y se compone con el resolver MCP HTTP (cada uno ignora las refs del otro).
 */
import type { McpServerRef } from '@core/contracts';
import type { IMcpToolResolver, McpTool, IConnectorRepository, ISecretStore } from '@core/engine';
import { resolveConnectorToken } from './connector-token';
import { getIntegration, integrationKeyFromUrl, type IntegrationToolCtx } from './integrations';
import { jiraAccessibleResources, type JiraFetch } from './jira-webhooks';

/** Timeout por petición: una API de Atlassian lenta/hostil no debe colgar la ejecución del agente (como McpHttpClient). */
const TIMEOUT_MS = 12_000;
const defaultFetch: JiraFetch = (url, init) => fetch(url, { ...(init as RequestInit), signal: AbortSignal.timeout(TIMEOUT_MS) });

export class IntegrationToolResolver implements IMcpToolResolver {
  constructor(
    private readonly connectors: IConnectorRepository,
    private readonly secrets: ISecretStore,
    private readonly fetchFn: JiraFetch = defaultFetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async resolve(workspaceId: string, servers: McpServerRef[]): Promise<McpTool[]> {
    const keys = Array.from(
      new Set(servers.map((s) => integrationKeyFromUrl(s.url)).filter((k): k is string => !!k)),
    );
    if (keys.length === 0) return [];
    const perKey = await Promise.all(keys.map((k) => this.forIntegration(workspaceId, k).catch(() => [])));
    return perKey.flat();
  }

  private async forIntegration(workspaceId: string, key: string): Promise<McpTool[]> {
    const def = getIntegration(key);
    if (!def) return [];
    const connectors = await this.connectors.listByWorkspace(workspaceId);
    const connector = connectors.find((c) => c.provider === def.provider && c.status === 'connected');
    if (!connector) return []; // integración no conectada → sin herramientas (la UI pide conectar)
    const resolved = await resolveConnectorToken(this.connectors, this.secrets, connector.id, workspaceId, this.now());
    if (!resolved) return [];
    // Atlassian necesita resolver el cloudId del sitio; el resto de proveedores (Sentry…) operan solo con el token.
    let cloudId: string | undefined;
    if (def.provider === 'jira') {
      const sites = await jiraAccessibleResources(resolved.token, this.fetchFn).catch(() => []);
      cloudId = sites[0]?.id;
      if (!cloudId) return [];
    }
    const ctx: IntegrationToolCtx = { token: resolved.token, cloudId, fetch: this.fetchFn };
    return def.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      scope: tool.scope, // M76: el runtime exige este scope RBAC antes de invocar (no confía solo en el enganche)
      invoke: async (args: Record<string, unknown>) => {
        try {
          return await tool.run(args, ctx);
        } catch (e) {
          // Timeout / fallo de red → error legible para el modelo, no cuelga ni rompe la ejecución.
          return { error: 'request_failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    }));
  }
}

/**
 * Compone varios `IMcpToolResolver` en uno: ejecuta todos sobre la MISMA lista de servers y concatena. Cada
 * resolver ignora las refs que no le tocan (el MCP HTTP salta las `integration://`; el de integraciones salta
 * las `http(s)://`), así que no se pisan. `undefined` si no hay ninguno activo.
 */
export function composeMcpResolvers(...resolvers: Array<IMcpToolResolver | undefined>): IMcpToolResolver | undefined {
  const active = resolvers.filter((r): r is IMcpToolResolver => !!r);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return {
    async resolve(workspaceId: string, servers: McpServerRef[]): Promise<McpTool[]> {
      const all = await Promise.all(active.map((r) => r.resolve(workspaceId, servers).catch(() => [])));
      return all.flat();
    },
  };
}
