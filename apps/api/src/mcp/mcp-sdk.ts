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
