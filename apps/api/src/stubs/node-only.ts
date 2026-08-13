/**
 * Stub que reemplaza en el bundle del Worker a las librerías que solo funcionan en Node: `tesseract.js`
 * (OCR), `pdf-parse` y `playwright(-core)`. Se enlaza por `alias` en `wrangler.jsonc`.
 *
 * ¿Por qué hace falta? `extract-node.ts` y los engines de navegador las cargan con un `require()`
 * PEREZOSO, pero eso solo difiere la EJECUCIÓN: el bundler las resuelve igual y acaban dentro del
 * Worker. Medido: 1,01 → 3,04 MB gzip de código que no puede correr ahí.
 *
 * El throw es de nivel de módulo a propósito. Como el `require` es perezoso, salta en el momento exacto
 * en que alguien ejecuta un nodo de OCR/PDF/navegador —no al arrancar el Worker— y dice qué falta.
 *
 * Los tres nodos tienen ALTERNATIVA que sí corre en Cloudflare, y es la salida recomendada mientras el
 * Container de `containers/runtime` no esté desplegado:
 *   - navegador → engine `browserbase` (CDP saliente, funciona desde un Worker tal cual)
 *   - OCR/PDF   → una API HTTP de extracción, como el resto de tools del catálogo
 */
throw new Error(
  'Este nodo (OCR, PDF o automatización de navegador) necesita el Container «runtime»: no puede correr ' +
    'dentro de un Worker. Ver docs/CLOUDFLARE.md (fase 5). Alternativas inmediatas: engine «browserbase» ' +
    'para navegador, o una tool HTTP de extracción para OCR/PDF.',
);
