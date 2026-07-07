import type { McpServerRef } from '@core/contracts';
import type { IMcpToolResolver, McpTool } from '@core/engine';
import { McpHttpClient } from './mcp-http-client';

/** Nombre de función válido para el modelo (^[a-zA-Z0-9_-]+): saneado y acotado. */
function safeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'tool';
}

/**
 * Resuelve los servidores MCP de un agente en herramientas invocables (M40). Conecta a cada servidor EN
 * PARALELO, lista sus tools y las envuelve; el `invoke` de cada una llama al servidor con su nombre original.
 * Las tools se prefijan con el nombre del servidor para no colisionar. Un servidor que falla se omite (su
 * error no rompe la ejecución del agente). No hay estado: se instancia una sola vez y se reutiliza.
 */
export class McpToolResolver implements IMcpToolResolver {
  async resolve(_workspaceId: string, servers: McpServerRef[]): Promise<McpTool[]> {
    const perServer = await Promise.all(servers.map((s) => this.fromServer(s)));
    return perServer.flat();
  }

  private async fromServer(server: McpServerRef): Promise<McpTool[]> {
    if (!/^https?:\/\//i.test(server.url)) return []; // solo http(s)
    try {
      const client = new McpHttpClient(server.url);
      await client.initialize();
      const tools = await client.listTools();
      return tools.map((tt) => ({
        name: safeName(`${server.name}_${tt.name}`),
        description: `[${server.name}] ${tt.description ?? tt.name}`.slice(0, 400),
        parameters: tt.inputSchema ?? {},
        invoke: (args: Record<string, unknown>) => client.callTool(tt.name, args),
      }));
    } catch {
      return []; // servidor inalcanzable / handshake fallido → sin tools, no rompe
    }
  }
}
