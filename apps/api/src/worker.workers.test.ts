import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

/**
 * El Worker ARRANCA y sirve, dentro de `workerd`.
 *
 * Es la red de seguridad que faltaba. `pnpm verify` compila y `wrangler deploy --dry-run` empaqueta,
 * pero ninguno de los dos ejecuta una sola línea en el runtime real: durante esta migración eso dejó
 * pasar dos fallos que solo aparecían en producción (NestJS colado en el bundle, y el contenedor DI
 * roto). Estos tests hacen peticiones de verdad contra el Worker montado con el `wrangler.jsonc` real.
 *
 * NO tocan base de datos: Hyperdrive apunta a una Postgres que no existe en el test. Lo que se afirma
 * aquí es lo que no depende de ella —que el módulo carga, que el router está cableado, que la auth es
 * deny-by-default y que los errores tienen la forma pactada—, que es justo la clase de fallo que se
 * escapaba.
 */
describe('El Worker arranca en workerd y sirve', () => {
  it('/health responde 200 (el módulo carga y el router está montado)', async () => {
    const res = await SELF.fetch('https://api.test/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('la raíz responde 200', async () => {
    const res = await SELF.fetch('https://api.test/');
    expect(res.status).toBe(200);
  });

  it('una ruta protegida SIN credencial es 401, no 500 (deny-by-default)', async () => {
    // Que sea 401 y no 500 prueba que el middleware de auth corre ANTES de tocar persistencia: con la
    // base de datos inalcanzable en este test, un orden equivocado saldría como error de conexión.
    const res = await SELF.fetch('https://api.test/workflows');
    expect(res.status).toBe(401);
  });

  it('una credencial inventada tampoco entra', async () => {
    const res = await SELF.fetch('https://api.test/workflows', {
      headers: { Authorization: 'Bearer no-soy-un-token' },
    });
    expect(res.status).toBe(401);
  });

  it('una ruta inexistente NO devuelve 501: ya no queda nada por portar', async () => {
    // Sale 401, no 404, porque el middleware de auth es deny-by-default y corre ANTES del enrutado: a
    // quien no se ha identificado no se le dice qué rutas existen. Es el mismo comportamiento que
    // tenía el guard global de Nest, así que la migración conserva el contrato.
    //
    // Lo que este test fija es que NUNCA vuelva a salir un 501: durante el port, lo no portado
    // respondía 501 con la lista de pendientes. Si alguien reintroduce un stub, esto lo canta.
    const res = await SELF.fetch('https://api.test/ruta-que-no-existe');
    expect(res.status).not.toBe(501);
    expect(res.status).toBe(401);
  });

  it('/ingest/config es público y dice si la telemetría está encendida', async () => {
    // Pública a propósito (el navegador la consulta antes de tener sesión) y sin BD: es la ruta ideal
    // para comprobar que la lista de rutas públicas se respeta dentro del runtime real.
    const res = await SELF.fetch('https://api.test/ingest/config');
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('enabled');
  });

  it('/insights exige sesión (analítica no es pública)', async () => {
    const res = await SELF.fetch('https://api.test/insights/overview');
    expect(res.status).toBe(401);
  });

  it('/mcp con cabecera lo rechaza el middleware global (paridad con el guard de Nest)', async () => {
    const res = await SELF.fetch('https://api.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
  });

  it('/mcp/:key es PÚBLICA: la petición llega al handler en vez de morir en el middleware', async () => {
    // La clave va en la URL para los clientes que no pueden poner cabeceras, así que la ruta está en
    // `public-routes.ts`. Lo que se afirma aquí es el cableado: que NO sale el 401 del middleware.
    //
    // No se puede llegar más lejos sin base de datos: resolver la clave consulta el repositorio, y en
    // esta suite Hyperdrive apunta a una Postgres que no existe (sale 500 al conectar). Que la clave
    // inválida responda en el sobre de JSON-RPC lo cubre el test unitario del router.
    const res = await SELF.fetch('https://api.test/mcp/af_clave_que_no_existe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).not.toBe(401);
  });

  it('CORS: la respuesta trae la cabecera que el navegador necesita', async () => {
    const res = await SELF.fetch('https://api.test/health', { headers: { Origin: 'https://web.test' } });
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy();
  });
});
