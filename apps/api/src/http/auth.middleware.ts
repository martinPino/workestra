import type { MiddlewareHandler } from 'hono';
import type { Role } from '@core/contracts';
import { setCurrentWorkspace } from '@core/infra/postgres';
import type { PersistenceBundle } from '../persistence/bundle';
import { isApiKey, resolveApiKey } from '../api-keys/api-key.util';
import { UnauthorizedException, InternalServerErrorException } from './common';
import { verifyJwt, type JwtPayload } from './jwt';
import { isPublicRoute } from './public-routes';

/**
 * Autenticación del API en Workers: port de `JwtAuthGuard`. Acepta las MISMAS dos credenciales —un JWT
 * de sesión o una API key `af_…` (M32)— y resuelve ambas al mismo principal, de modo que todo el
 * scoping por tenant y el RBAC posteriores funcionan igual venga de donde venga.
 *
 * Es deny-by-default: exige credencial en toda ruta que no esté en `public-routes.ts`.
 */

/** Estado autoritativo de la cuenta, cacheado brevemente para no consultar la BD en CADA petición (M74). */
interface AccountStatus {
  disabled: boolean;
  role: Role;
  workspaceId: string;
}

const STATUS_TTL_MS = 10_000; // ventana máxima de revocación tras «cerrar cuenta»: 10s

/**
 * Cache a nivel de MÓDULO, no de instancia. En Nest el guard era un singleton del proceso; aquí el
 * equivalente es el isolate, que Cloudflare reutiliza entre peticiones. La diferencia práctica: un
 * isolate puede morir en cualquier momento y perder la cache, lo que solo hace la revocación MÁS rápida
 * (se vuelve a leer la BD), nunca más lenta. El TTL sigue acotando la ventana a 10 s.
 */
const statusCache = new Map<string, { status: AccountStatus | null; exp: number }>();

/**
 * Estado autoritativo de una cuenta por email, con cache de 10 s. Devuelve `null` si no se pudo
 * determinar (usuario inexistente o error de BD) → el llamador hace FAIL-OPEN (usa el token) para no
 * tumbar la auth entera ante un fallo transitorio de BD; la única acción «dura» es rechazar cuando la
 * cuenta está cerrada.
 */
async function statusOf(persistence: PersistenceBundle, email: string): Promise<AccountStatus | null> {
  const now = Date.now();
  const cached = statusCache.get(email);
  if (cached && cached.exp > now) return cached.status;

  let status: AccountStatus | null = null;
  try {
    const acct = await persistence.auth.findByEmail(email);
    if (acct) status = { disabled: !!acct.disabledAt, role: acct.role, workspaceId: acct.workspaceId };
  } catch {
    status = null; // error de BD → fail-open (no cacheamos un fallo transitorio mucho tiempo)
  }
  statusCache.set(email, { status, exp: now + STATUS_TTL_MS });
  if (statusCache.size > 5000) {
    for (const [k, v] of statusCache) if (v.exp <= now) statusCache.delete(k);
  }
  return status;
}

/**
 * Extrae la credencial. Normalmente del `Authorization: Bearer`, pero un WebSocket de navegador NO
 * puede fijar cabeceras: la API `WebSocket` del navegador solo deja pasar subprotocolos. Por eso se
 * acepta también `Sec-WebSocket-Protocol: bearer, <token>`, que es el patrón habitual.
 *
 * NO se acepta por query string, que era la otra opción: la URL acaba en logs de acceso, historiales y
 * cabeceras `Referer`, y ahí un token de sesión de 7 días es una credencial filtrada.
 */
function bearerToken(authorization?: string, wsProtocol?: string): string | null {
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  if (wsProtocol) {
    const parts = wsProtocol.split(',').map((p) => p.trim());
    if (parts[0] === 'bearer' && parts[1]) return parts[1];
  }
  return null;
}

/** Variables que este middleware deja en el contexto para los handlers. */
export interface AuthVariables {
  user: JwtPayload;
  persistence: PersistenceBundle;
}

/**
 * Middleware de autenticación. `jwtSecret` se pasa explícitamente (no se lee de `process.env` aquí) para
 * que el fallo por secreto ausente ocurra al construir el app, no en la primera petición.
 */
export function authMiddleware(jwtSecret: string): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    if (isPublicRoute(c.req.method, new URL(c.req.url).pathname)) return next();

    const token = bearerToken(c.req.header('authorization'), c.req.header('sec-websocket-protocol'));
    if (!token) throw new UnauthorizedException('Falta el Bearer token.');

    const persistence = c.get('persistence');
    if (!persistence) throw new InternalServerErrorException('El bundle de persistencia no está en el contexto.');

    // API key (`af_…`): resuelve al MISMO principal que un JWT (sub/email/role/workspaceId).
    if (isApiKey(token)) {
      const principal = await resolveApiKey(persistence.apiKeys, token);
      if (!principal) throw new UnauthorizedException('API key inválida o revocada.');
      // Una clave cuyo dueño fue «cerrado» deja de funcionar (offboarding). Fail-open si la BD falla.
      const status = await statusOf(persistence, principal.email);
      if (status?.disabled) throw new UnauthorizedException('Cuenta desactivada.');
      const user = status ? { ...principal, role: status.role, workspaceId: status.workspaceId } : principal;
      c.set('user', user as JwtPayload);
      setCurrentWorkspace(user.workspaceId);
      return next();
    }

    const payload = await verifyJwt(token, jwtSecret);
    // Rechaza tokens que NO son de sesión (p. ej. el `oauth_state` de conectores, firmado con el mismo
    // secreto). Un token de sesión no lleva `kind`; uno con `kind` no es un principal válido.
    if (payload.kind) throw new UnauthorizedException('Tipo de token no válido para sesión.');

    // Revalidación por petición (M74): «cerrar cuenta» debe revocar el acceso YA, no solo en el próximo
    // login. Si hay estado autoritativo, MANDA sobre el token (corrige también un rol degradado). Si la
    // BD falló, caemos al token para no provocar una caída total de auth.
    const status = await statusOf(persistence, payload.email);
    if (status?.disabled) throw new UnauthorizedException('Cuenta desactivada.');
    const user: JwtPayload = status
      ? { sub: payload.sub, email: payload.email, role: status.role, workspaceId: status.workspaceId }
      : payload;

    c.set('user', user);
    if (user.workspaceId) setCurrentWorkspace(user.workspaceId);
    return next();
  };
}

/**
 * El `workspaceId` AUTENTICADO, equivalente del decorador `@Workspace()`. Sale del principal validado,
 * NUNCA de una cabecera o query que el cliente controle: es la única fuente de verdad del tenant para
 * acotar consultas y validar propiedad de recursos.
 */
export function workspaceOf(user: JwtPayload | undefined): string {
  const ws = user?.workspaceId;
  if (!ws) throw new InternalServerErrorException('Falta workspaceId en el token autenticado.');
  return ws;
}

/** Vacía la cache de estado. Solo para tests: un test no debe heredar el estado de otro. */
export function __resetStatusCache(): void {
  statusCache.clear();
}
