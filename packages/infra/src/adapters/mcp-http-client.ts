/**
 * Cliente MCP mínimo sobre Streamable HTTP (M40), suficiente para enganchar servidores MCP externos a un
 * agente: `initialize` → `tools/list` → `tools/call`. Sin dependencias del SDK (evita el lío CJS/ESM en el
 * worker); usa `fetch` global (Node 22). Acepta respuestas JSON o SSE (`text/event-stream`) y mantiene el
 * `Mcp-Session-Id` entre llamadas. Con timeout por petición para no colgar la ejecución del agente.
 */
interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const TIMEOUT_MS = 12_000;

export class McpHttpClient {
  private sessionId?: string;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${method}`);
    const ct = res.headers.get('content-type') ?? '';
    const text = await res.text();
    const msg = ct.includes('text/event-stream') ? parseSseForId(text, id) : (safeJson(text) as JsonRpcMessage);
    if (msg?.error) throw new Error(`${method}: ${msg.error.message ?? 'error MCP'}`);
    return msg?.result;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await fetch(this.url, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.extraHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => undefined);
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentflow', version: '1.0' },
    });
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpToolInfo[]> {
    const r = (await this.rpc('tools/list')) as { tools?: McpToolInfo[] } | undefined;
    return r?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.rpc('tools/call', { name, arguments: args });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Extrae el mensaje JSON-RPC con el `id` esperado de un flujo SSE (`data: {...}` separados por línea en blanco). */
function parseSseForId(text: string, id: number): JsonRpcMessage {
  const frames = text.split(/\n\n/);
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!data) continue;
    const obj = safeJson(data) as JsonRpcMessage;
    if (obj && obj.id === id) return obj;
  }
  return {};
}
