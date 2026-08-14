import { Hono, type Context } from 'hono';
import { setCurrentWorkspace } from '@core/infra/postgres';
import { resolveApiKey, type ApiKeyPrincipal } from '../../api-keys/api-key.util';
import type { McpService } from '../../mcp/mcp.service';
import type { JsonRpcMessage } from '../../mcp/mcp-sdk';
import type { RouterEnv } from './types';

type Ctx = Context<RouterEnv>;

/**
 * Endpoint MCP (M32). Dos formas de auth, para máxima compatibilidad de clientes:
 *  - `/mcp` con cabecera `Authorization: Bearer af_…` (o un JWT de sesión): la resuelve el middleware
 *    global de auth, igual que cualquier otra ruta.
 *  - `/mcp/:key` con la clave embebida en la URL: para clientes que no permiten cabeceras (algunos
 *    conectores de Claude Desktop/ChatGPT). Es pública (ver `public-routes.ts`) y resuelve la clave
 *    aquí mismo, aplicando el MISMO RBAC (lo aplican las tools contra el principal).
 *
 * El servidor es SIN ESTADO (ver `mcp.service.ts`): no se emite `Mcp-Session-Id` y cada petición se
 * basta a sí misma, porque en Workers no hay proceso donde guardar sesiones.
 */
export function mcpRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  // Con cabecera: el principal ya lo puso el middleware de auth.
  for (const method of ['post', 'get', 'delete'] as const) {
    r[method]('/', async (c) => {
      const user = c.get('user');
      if (!user?.workspaceId) return jsonRpcError(c, 401, -32001, 'Se requiere autenticación.');
      return serve(c, user as ApiKeyPrincipal);
    });
  }

  // Con la clave en la URL: ruta pública que autentica aquí.
  for (const method of ['post', 'get', 'delete'] as const) {
    r[method]('/:key', async (c) => {
      const principal = await resolveApiKey(c.get('persistence').apiKeys, c.req.param('key'));
      if (!principal) return jsonRpcError(c, 401, -32001, 'API key inválida o revocada.');
      // El middleware de auth no corre en rutas públicas: el tenant se fija aquí, dentro del contexto
      // que abrió el worker, para que la barrera RLS de Prisma vea el workspace correcto.
      setCurrentWorkspace(principal.workspaceId);
      return serve(c, principal);
    });
  }

  return r;
}

/** Lee el mensaje, lo procesa y responde. Notificación (sin `id`) → 202 sin cuerpo. */
async function serve(c: Ctx, principal: ApiKeyPrincipal): Promise<Response> {
  let message: JsonRpcMessage;
  try {
    const body = await c.req.json();
    if (!body || typeof body !== 'object') throw new Error('no es un objeto');
    message = body as JsonRpcMessage;
  } catch {
    return jsonRpcError(c, 400, -32700, 'Cuerpo JSON-RPC inválido.');
  }
  const reply = await c.get('services').mcp.handle(message, principal);
  return reply ? c.json(reply) : c.body(null, 202);
}

/** Error en el sobre de JSON-RPC: los clientes MCP esperan esta forma, no la de error HTTP de la API. */
function jsonRpcError(c: Ctx, status: 400 | 401, code: number, message: string): Response {
  return c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, status);
}
