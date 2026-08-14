import { McpServer, WebTransport, type JsonRpcMessage } from './mcp-sdk';
import type { McpServerLike } from './mcp-sdk';
import { registerTools, type McpContext } from './tools';
import { registerArchitectTools } from './architect';
import { registerResources } from './resources';
import { registerPrompts } from './prompts';
import { WorkflowsService } from '../workflows/workflows.service';
import { AgentsService } from '../agents/agents.service';
import { ExecutionsService } from '../execution/executions.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { RbacService } from '../rbac/rbac.service';
import type { ApiKeyPrincipal } from '../api-keys/api-key.util';

/**
 * Servidor MCP montado en la API (M32). En cada petición se crea un `McpServer` con las tools,
 * resources y prompts ligados al principal autenticado (workspace + rol), de modo que TODO queda
 * acotado a su tenant.
 *
 * ── Sin sesión, y por qué ─────────────────────────────────────────────────────────────────────────
 * La versión de Railway guardaba un `Map` de sesiones por `mcp-session-id` en la instancia del
 * servicio, que vivía tanto como el proceso. En Workers no hay proceso: los servicios se construyen
 * POR PETICIÓN y cada petición puede caer en un isolate distinto, así que ese `Map` estaría casi
 * siempre vacío. No sería un fallo ruidoso —el `initialize` funcionaría y la siguiente llamada diría
 * «sesión caducada»— sino intermitente, que es peor.
 *
 * Así que cada petición se basta a sí misma: se construye el servidor, se le da la vuelta al mensaje y
 * se responde. Es el modo que el propio SDK recomienda para serverless. El coste es rearmar el
 * registro de tools por petición (objetos en memoria, sin IO); lo que se gana es que no hay estado
 * pegado a un isolate que pueda desaparecer entre dos llamadas del mismo cliente.
 */
export class McpService {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly agents: AgentsService,
    private readonly executions: ExecutionsService,
    private readonly connectors: ConnectorsService,
    private readonly rbac: RbacService,
  ) {}

  private createServer(principal: ApiKeyPrincipal): McpServerLike {
    const server = new McpServer({ name: 'agentflow', version: '1.0.0' });
    const ctx: McpContext = {
      principal,
      workflows: this.workflows,
      agents: this.agents,
      executions: this.executions,
      connectors: this.connectors,
      rbac: this.rbac,
    };
    registerTools(server, ctx);
    registerArchitectTools(server, ctx);
    registerResources(server, ctx);
    registerPrompts(server, ctx);
    return server;
  }

  /**
   * Procesa un mensaje JSON-RPC y devuelve la respuesta, o `null` si era una notificación (a las que
   * el protocolo no contesta). Quien llama traduce eso a 200 con cuerpo o 202 sin él.
   */
  async handle(message: JsonRpcMessage, principal: ApiKeyPrincipal): Promise<JsonRpcMessage | null> {
    const transport = new WebTransport();
    const server = this.createServer(principal);
    await server.connect(transport);
    try {
      return await transport.dispatch(message);
    } finally {
      await transport.close();
    }
  }
}
