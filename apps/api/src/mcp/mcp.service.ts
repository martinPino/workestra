import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable } from '../http/common';
import { McpServer, StreamableHTTPServerTransport, isInitializeRequest } from './mcp-sdk';
import type { McpServerLike, StreamableTransportLike } from './mcp-sdk';
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
 * Servidor MCP montado en la API (M32), transporte Streamable HTTP. Mantiene una sesión por conexión
 * (Map por `mcp-session-id`); en cada `initialize` crea un McpServer con las tools/resources ligados al
 * principal autenticado (workspace + rol), de modo que TODO queda acotado a su tenant.
 */
@Injectable()
export class McpService {
  private readonly sessions = new Map<string, StreamableTransportLike>();

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
   * Maneja una petición MCP (POST mensajes / GET stream SSE / DELETE cierre). `principal` lo resuelve el
   * controller (cabecera Bearer o key en la URL). Reutiliza la sesión si existe; si es un `initialize`
   * sin sesión, crea transporte + servidor. El transporte ESCRIBE la respuesta (no devolvemos nada).
   */
  async handle(req: IncomingMessage, res: ServerResponse, body: unknown, principal: ApiKeyPrincipal): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    const existing = sessionId ? this.sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => this.sessions.set(sid, transport),
        // Respuesta JSON directa (no SSE): es un servidor de tools request/response; compatible con los
        // clientes y más simple. No usamos mensajes iniciados por el servidor (progreso/streaming).
        enableJsonResponse: true,
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) this.sessions.delete(sid);
      };
      const server = this.createServer(principal);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Falta o caducó mcp-session-id. Inicia con una petición initialize.' },
        id: null,
      }),
    );
  }
}
