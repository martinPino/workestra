/* eslint-disable @typescript-eslint/no-require-imports */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodRawShape } from 'zod';

/**
 * Aislamiento del SDK MCP (M32). El paquete `@modelcontextprotocol/sdk` es dual CJS/ESM, pero la API
 * compila con `moduleResolution: node` (clásico), que NO resuelve sus subpaths por tipos (usa `exports`).
 * Solución: cargarlo con `require` (el runtime SÍ honra `exports` → build CJS) y declarar aquí las firmas
 * mínimas que usamos. Todo el acoplamiento al SDK vive en este único fichero.
 */

/** Resultado de una tool (subset del CallToolResult del SDK). */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
/** Resultado de leer un resource. */
export interface McpResourceResult {
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
}
/** Resultado de un prompt (lista de mensajes que el cliente inyecta en la conversación). */
export interface McpPromptResult {
  messages: Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }>;
}

/** Plantilla de URI para resources dinámicos, p. ej. `workflow://{id}`. Opaca; se crea con ResourceTemplate. */
export interface ResourceTemplateLike {
  readonly _brand?: 'ResourceTemplate';
}

export interface McpServerLike {
  registerTool(
    name: string,
    config: { title?: string; description?: string; inputSchema?: ZodRawShape; annotations?: Record<string, unknown> },
    // args llega ya parseado por el inputSchema (zod); `any` permite destructuring flexible en los handlers.
    cb: (args: any) => Promise<McpToolResult> | McpToolResult,
  ): unknown;
  registerResource(
    name: string,
    uriOrTemplate: string | ResourceTemplateLike,
    config: { title?: string; description?: string; mimeType?: string },
    cb: (uri: URL, variables: Record<string, string | string[]>) => Promise<McpResourceResult> | McpResourceResult,
  ): unknown;
  registerPrompt(
    name: string,
    config: { title?: string; description?: string; argsSchema?: ZodRawShape },
    cb: (args: any) => McpPromptResult | Promise<McpPromptResult>,
  ): unknown;
  connect(transport: unknown): Promise<void>;
}

export interface StreamableTransportLike {
  readonly sessionId: string | undefined;
  onclose?: () => void;
  handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>;
  close(): Promise<void>;
}

const mcpMod = require('@modelcontextprotocol/sdk/server/mcp.js') as {
  McpServer: new (info: { name: string; version: string }) => McpServerLike;
  ResourceTemplate: new (
    uriTemplate: string,
    callbacks: { list?: (() => Promise<{ resources: Array<{ name: string; uri: string }> }>) | undefined },
  ) => ResourceTemplateLike;
};
const httpMod = require('@modelcontextprotocol/sdk/server/streamableHttp.js') as {
  StreamableHTTPServerTransport: new (opts: {
    sessionIdGenerator?: (() => string) | undefined;
    onsessioninitialized?: (sessionId: string) => void;
    enableJsonResponse?: boolean;
  }) => StreamableTransportLike;
};
const typesMod = require('@modelcontextprotocol/sdk/types.js') as {
  isInitializeRequest: (value: unknown) => boolean;
};

export const McpServer = mcpMod.McpServer;
export const ResourceTemplate = mcpMod.ResourceTemplate;
export const StreamableHTTPServerTransport = httpMod.StreamableHTTPServerTransport;
export const isInitializeRequest = typesMod.isInitializeRequest;

/** Mensaje JSON-RPC, en lo poco que necesitamos mirar de él. */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  [k: string]: unknown;
}

/**
 * Transporte MCP sobre el estándar web, para Cloudflare Workers.
 *
 * El transporte del SDK (`StreamableHTTPServerTransport`) escribe sobre `ServerResponse` de Node, que
 * en workerd no existe. En vez de falsificar los objetos http de Node —una superficie grande y frágil,
 * con streams y `writeHead`—, se implementa la interfaz `Transport` del propio SDK, que es diminuta:
 * `start`/`send`/`close` más los callbacks. `Protocol.connect()` acepta cualquier cosa que la cumpla,
 * así que el servidor MCP, las tools, los resources y los prompts se usan SIN tocarlos.
 *
 * Es SIN ESTADO a propósito: una petición entra, se le da la vuelta al protocolo y se responde. En
 * Workers no hay proceso donde guardar un `Map` de sesiones —cada petición puede caer en un isolate
 * distinto—, así que la sesión pegada al proceso, que en Railway era gratis, aquí sería un error
 * silencioso: funcionaría en local y fallaría de forma intermitente en producción. El modo sin sesión
 * es el que el propio SDK recomienda para serverless.
 */
export class WebTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JsonRpcMessage) => void;
  /** Sin sesión: no se emite `Mcp-Session-Id` y cada petición se basta a sí misma. */
  readonly sessionId: string | undefined = undefined;

  private resolve: ((m: JsonRpcMessage | null) => void) | null = null;

  async start(): Promise<void> {}

  /** El servidor responde por aquí. Se captura el mensaje y se desbloquea a `dispatch`. */
  async send(message: JsonRpcMessage): Promise<void> {
    this.resolve?.(message);
    this.resolve = null;
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  /**
   * Mete un mensaje entrante y espera la respuesta del servidor.
   *
   * Devuelve `null` cuando el mensaje es una NOTIFICACIÓN (sin `id`): el protocolo no contesta a las
   * notificaciones, así que esperar respuesta colgaría la petición para siempre. Quien llama traduce
   * ese `null` a un 202 sin cuerpo.
   */
  async dispatch(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    if (message.id === undefined || message.id === null) {
      this.onmessage?.(message);
      return null;
    }
    return new Promise<JsonRpcMessage | null>((resolve, reject) => {
      this.resolve = resolve;
      const prev = this.onerror;
      this.onerror = (e) => {
        prev?.(e);
        reject(e);
      };
      try {
        this.onmessage?.(message);
      } catch (e) {
        reject(e as Error);
      }
    });
  }
}
