/**
 * Las ÚNICAS rutas que no exigen autenticación. Todo lo demás la exige: el middleware de auth es
 * deny-by-default y consulta esta lista, igual que el guard global de Nest consultaba `@Public()`.
 *
 * Concentrarlas aquí es a propósito. En Nest la superficie pública estaba repartida en 8 controllers, y
 * para auditarla había que ir fichero por fichero mirando dónde caía un decorador. Aquí se lee entera de
 * un vistazo y se puede testear. La alternativa idiomática en Hono —montar los routers públicos ANTES
 * del middleware— se descartó porque convierte un error de ORDEN en una ruta abierta en silencio, que es
 * exactamente el fallo que no se quiere poder cometer.
 */

/** Patrón de ruta con `:param`, igual que en los controllers. `*` como método = cualquiera. */
interface PublicRoute {
  method: string;
  path: string;
  why: string;
}

const PUBLIC_ROUTES: PublicRoute[] = [
  { method: 'GET', path: '/', why: 'health check del PaaS' },
  { method: 'GET', path: '/health', why: 'health check del PaaS' },

  // Alta y entrada: por definición no hay sesión todavía. `/auth/token` es el minter de dev, que
  // además está fail-closed dentro del handler (solo con AUTH_MODE=dev y fuera de producción).
  { method: 'POST', path: '/auth/register', why: 'aún no hay sesión' },
  { method: 'POST', path: '/auth/login', why: 'aún no hay sesión' },
  { method: 'POST', path: '/auth/token', why: 'minter de dev, fail-closed en el handler' },

  // Invitaciones (M74): quien las acepta todavía no tiene cuenta. El token de la URL es la credencial.
  { method: 'GET', path: '/team/invite/:token', why: 'el invitado aún no tiene cuenta' },
  { method: 'POST', path: '/team/invite/:token/accept', why: 'el invitado aún no tiene cuenta' },

  // Callbacks OAuth: los invoca el navegador redirigido por el proveedor, sin nuestra cabecera.
  // OJO: son literales. `/connectors/:id/...` NO es público, y por eso `callback` va como ruta exacta.
  { method: 'GET', path: '/connectors/callback', why: 'redirección del proveedor OAuth' },
  { method: 'GET', path: '/connectors/sentry-app/callback', why: 'redirección del proveedor OAuth' },

  // Proveedor OAuth de juguete para desarrollo. No se registra en producción.
  { method: 'GET', path: '/oauth/dev/authorize', why: 'proveedor OAuth de dev' },
  { method: 'POST', path: '/oauth/dev/token', why: 'proveedor OAuth de dev' },
  { method: 'GET', path: '/oauth/dev/api/whoami', why: 'proveedor OAuth de dev' },

  // Ingreso de webhooks: los llama un tercero. No llevan sesión; su credencial es la FIRMA HMAC, que
  // el handler verifica sobre los bytes exactos recibidos.
  { method: 'POST', path: '/hooks/:token', why: 'entrante de tercero; autentica por firma HMAC' },
  { method: 'POST', path: '/hooks/jira/:connectorId', why: 'entrante de tercero; autentica por firma HMAC' },
  { method: 'POST', path: '/hooks/sentry', why: 'entrante de tercero; autentica por firma HMAC' },

  // Lectura de un enlace compartido (M85): el token de la URL ES la credencial. Solo la LECTURA;
  // importar o revocar exigen sesión.
  { method: 'GET', path: '/shares/:token', why: 'el token de la URL es la credencial' },

  // MCP con la clave en la URL: lo usan conectores (Claude Desktop/ChatGPT) que no pueden poner
  // cabeceras. El handler resuelve la API key y aplica el mismo RBAC.
  { method: 'POST', path: '/mcp/:key', why: 'la API key va en la URL; el handler la resuelve' },
  { method: 'GET', path: '/mcp/:key', why: 'la API key va en la URL; el handler la resuelve' },
  { method: 'DELETE', path: '/mcp/:key', why: 'la API key va en la URL; el handler la resuelve' },

  // Si la telemetría está encendida. El navegador lo consulta antes de saber quién es (el proveedor
  // envuelve también /login) y no revela nada más que un booleano.
  { method: 'GET', path: '/ingest/config', why: 'se consulta antes de tener sesión; solo devuelve un booleano' },
];

/** Compila `/team/invite/:token/accept` a un regex anclado. `:param` no cruza barras. */
function toRegExp(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

const COMPILED = PUBLIC_ROUTES.map((r) => ({ method: r.method, re: toRegExp(r.path) }));

/**
 * ¿Esta petición puede pasar sin autenticar? Compara la ruta NORMALIZADA (sin query ni barra final)
 * contra la lista. Cualquier cosa que no esté, exige sesión.
 */
export function isPublicRoute(method: string, pathname: string): boolean {
  // Se normaliza la barra final para que `/health/` no esquive la lista por la vía contraria: aquí
  // fallaría hacia «exige auth», pero la asimetría entre rutas equivalentes es peor que el caso.
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const m = method.toUpperCase();
  return COMPILED.some((r) => r.method === m && r.re.test(path));
}

/** La lista, para tests y auditoría. */
export const publicRoutes = (): readonly PublicRoute[] => PUBLIC_ROUTES;
