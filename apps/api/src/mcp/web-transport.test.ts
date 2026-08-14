import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer, WebTransport, type JsonRpcMessage } from './mcp-sdk';
import type { McpServerLike } from './mcp-sdk';

/**
 * El transporte MCP sobre el estándar web (el que hace posible correr en Workers).
 *
 * Estos tests conducen el PROTOCOLO de verdad —handshake, listar tools, llamarlas— contra un servidor
 * MCP real del SDK. Es la única forma de saber que el transporte casero cumple el contrato: comprobar
 * que la clase «tiene los métodos» no dice nada sobre si el SDK sabe hablar con ella.
 */

/**
 * Servidor mínimo con una tool que devuelve lo que le pasan.
 *
 * El `inputSchema` es OBLIGATORIO para que lleguen argumentos: el SDK parsea `arguments` contra él y,
 * sin esquema, el handler recibe un objeto vacío. (Lo descubrió este mismo test, que fallaba con
 * `'eco: '` en vez de `'eco: hola'`.)
 */
function serverWithEcho(): McpServerLike {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  server.registerTool(
    'eco',
    { description: 'Devuelve el texto recibido', inputSchema: { texto: z.string() } },
    async (args: { texto?: string }) => ({
      content: [{ type: 'text' as const, text: `eco: ${args?.texto ?? ''}` }],
    }),
  );
  return server;
}

/** Abre transporte + servidor, como hace `McpService.handle` en cada petición. */
async function connect(server: McpServerLike = serverWithEcho()) {
  const transport = new WebTransport();
  await server.connect(transport);
  return transport;
}

const initialize: JsonRpcMessage = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

describe('WebTransport — el handshake de MCP funciona sin objetos de Node', () => {
  it('responde a `initialize` con las capacidades del servidor', async () => {
    const t = await connect();
    const reply = (await t.dispatch(initialize)) as { result?: { serverInfo?: { name?: string } } } | null;

    expect(reply).not.toBeNull();
    expect(reply?.result?.serverInfo?.name).toBe('test');
  });

  it('una NOTIFICACIÓN no espera respuesta (o la petición se colgaría para siempre)', async () => {
    const t = await connect();
    await t.dispatch(initialize);

    // `notifications/initialized` no lleva `id`: el protocolo no contesta. Si `dispatch` esperase una
    // respuesta aquí, el Worker se quedaría colgado hasta agotar el tiempo de la petición.
    const reply = await t.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(reply).toBeNull();
  });

  it('lista las tools registradas tras el handshake', async () => {
    const t = await connect();
    await t.dispatch(initialize);
    await t.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const reply = (await t.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result?: { tools?: Array<{ name: string }> };
    } | null;

    expect(reply?.result?.tools?.map((x) => x.name)).toContain('eco');
  });

  it('ejecuta una tool y devuelve su resultado', async () => {
    const t = await connect();
    await t.dispatch(initialize);
    await t.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const reply = (await t.dispatch({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'eco', arguments: { texto: 'hola' } },
    })) as { result?: { content?: Array<{ text: string }> } } | null;

    expect(reply?.result?.content?.[0]?.text).toBe('eco: hola');
  });

  it('un método desconocido devuelve error JSON-RPC, no una excepción', async () => {
    const t = await connect();
    await t.dispatch(initialize);

    const reply = (await t.dispatch({ jsonrpc: '2.0', id: 4, method: 'metodo/inventado' })) as {
      error?: { code: number };
    } | null;

    expect(reply?.error?.code).toBeTypeOf('number');
  });

  it('NO emite sessionId: el servidor es sin estado a propósito', async () => {
    // Si emitiera uno, el cliente lo mandaría en la siguiente petición esperando que el servidor la
    // recordase — y en Workers esa petición puede caer en otro isolate que no sabe nada.
    const t = await connect();
    expect(t.sessionId).toBeUndefined();
  });

  it('cada conexión es independiente: una petición nueva revive el protocolo entero', async () => {
    // Es la propiedad que hace viable el modo sin sesión: dos peticiones consecutivas de un cliente
    // pueden caer en isolates distintos y cada una hace su handshake.
    for (let i = 0; i < 3; i++) {
      const t = await connect();
      const reply = (await t.dispatch(initialize)) as { result?: unknown } | null;
      expect(reply?.result).toBeDefined();
    }
  });
});
