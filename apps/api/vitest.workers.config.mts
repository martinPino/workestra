import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Tests que corren DENTRO de `workerd`, el runtime real de Cloudflare.
 *
 * Por qué existen aparte de `vitest run` (que corre en Node): `workerd` NO es Node. Un test verde en
 * Node no dice nada sobre si el Worker arranca — la migración ya se llevó dos veces ese golpe (NestJS
 * entero colado en el bundle por un import, y el contenedor DI roto sin que ningún test lo notara).
 * `wrangler deploy --dry-run` prueba que el bundle SE CONSTRUYE; esto prueba que además CORRE.
 *
 * Los unitarios se quedan en Node a propósito: son lógica pura (RBAC, cron, sanitizador, protocolo MCP)
 * y no ganan nada por cambiar de runtime, mientras que moverlos costaría pelearse con `process.env` y
 * los mocks en cada uno. Aquí va lo que solo se puede afirmar del runtime de verdad.
 *
 * OJO con las versiones: el pool exige vitest 4, y el resto del monorepo sigue en vitest 2 (subirlo a
 * todos arrastraría también vite 5 → 6 en la web). Por eso `apps/api` lleva su PROPIO vitest y vite en
 * devDependencies: pnpm aísla por paquete y nadie más se entera.
 *
 *   pnpm --filter @app/api test:workers
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Se lee el wrangler.jsonc real: bindings, flags de compatibilidad y aliases del test son
      // EXACTAMENTE los de producción. Si divergieran, el test dejaría de ser evidencia.
      //
      // Hyperdrive exige además una cadena de conexión local para poder construir la config, aunque
      // estos tests no toquen la base de datos; se pasa por entorno desde el script `test:workers`
      // para no meter una cadena de desarrollo en el wrangler.jsonc de producción.
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // El Worker es FAIL-CLOSED: sin un `JWT_SECRET` propio se niega a servir (lo descubrió este
        // mismo test, que empezó fallando las 9 aserciones con «JWT_SECRET debe fijarse»). Se le da uno
        // de mentira para poder ejercitar las rutas; que haga falta es la garantía que queremos.
        bindings: { JWT_SECRET: 'secreto-solo-para-tests-no-usar-en-ningun-sitio' },
      },
    }),
  ],
  test: {
    include: ['src/**/*.workers.test.ts'],
  },
});
