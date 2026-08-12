/**
 * Stub que reemplaza en el bundle del Worker a las librerías que solo funcionan en Node: `tesseract.js`
 * (OCR), `pdf-parse` y `playwright(-core)`. Se enlaza por `alias` en `wrangler.jsonc`.
 *
 * ¿Por qué hace falta? `extract-node.ts` y los engines de navegador las cargan con un `require()` PEREZOSO
 * («solo se carga cuando llega un PDF»), pero eso solo difiere la EJECUCIÓN: el bundler las resuelve
 * igual y acaban dentro del Worker. Medido: 1,01 → 3,04 MB gzip de código que no puede correr ahí.
 *
 * El throw es de nivel de módulo a propósito. Como el `require` es perezoso, salta en el momento exacto
 * en que alguien ejecuta un nodo de OCR/PDF/navegador — no al arrancar el Worker— y dice por qué. La
 * alternativa (dejarlas en el bundle) daría un fallo críptico de `fs` o `child_process` en el mismo
 * punto, pesando 2 MB más.
 *
 * Se retira en la fase 5, cuando esos tres nodos pasen a Containers/Sandboxes.
 */
throw new Error(
  'Este nodo (OCR, PDF o automatización de navegador) todavía no está portado a Cloudflare: ' +
    'necesita Containers/Sandboxes (fase 5 de docs/CLOUDFLARE.md). Ejecútalo en el despliegue de Railway.',
);
