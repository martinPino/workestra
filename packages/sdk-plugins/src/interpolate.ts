import type { ExecutionContext } from '@core/contracts';

/**
 * Lee `path` (dot-notation) de un objeto. Las claves de variable pueden contener `:` e incluso `.`
 * (p. ej. `connector:c`, o un nodo cuya key es `read.msg` → variable `connector:read.msg`), así que
 * en cada nivel se prueba el prefijo de segmentos MÁS LARGO que sea una propiedad PROPIA del objeto
 * antes de descender. Solo se leen propiedades propias: nunca la cadena de prototipos, de modo que
 * `{{toString}}`, `{{constructor}}`, `{{__proto__}}`, etc. resuelven a `undefined` (no a funciones
 * heredadas ni a `Object.prototype`) y no rompen la interpolación.
 */
function getPath(root: unknown, path: string): unknown {
  const parts = path.trim().split('.');
  let node: unknown = root;
  let i = 0;
  while (i < parts.length) {
    if (node == null || typeof node !== 'object') return undefined;
    const obj = node as Record<string, unknown>;
    let matched = false;
    // Prefijo más largo primero: permite claves compuestas con `.` (p. ej. `connector:read.msg`).
    for (let j = parts.length; j > i; j--) {
      const key = parts.slice(i, j).join('.');
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        node = obj[key];
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) return undefined;
  }
  return node;
}

/** Escapa `value` como FRAGMENTO de string JSON (sin las comillas envolventes). Un valor no-string se
 *  serializa primero a su forma JSON y esa cadena se escapa: así incrustar `{{x}}` dentro de una
 *  cadena JSON (`"...{{x}}..."`) SIEMPRE produce JSON válido, aunque el valor sea objeto/array. */
function jsonStringFragment(value: unknown): string {
  const asString = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return JSON.stringify(asString).slice(1, -1);
}

/**
 * Resuelve `{{path}}` en `template` contra el contexto de ejecución — así un nodo puede usar la
 * SALIDA de otro (p. ej. el cuerpo de un conector `{"text":"{{agent:LLM.output}}"}` usa la respuesta
 * del agente, o `{{connector:c.bodyPreview}}` usa lo que devolvió otro conector). Es el motor de
 * flujo de datos entre nodos.
 *
 * Búsqueda: las variables del contexto están en la raíz (`{{connector:c...}}`), y también `ticket` /
 * `repository` / `variables`. Con `jsonSafe`, cada valor se incrusta como fragmento de string JSON
 * escapado: el placeholder debe ir DENTRO de una cadena (`"...{{x}}..."`) y nunca puede romper la
 * estructura del JSON ni inyectar claves/valores, sea cual sea el tipo del valor resuelto.
 */
export function interpolate(template: string, ctx: ExecutionContext, jsonSafe = false): string {
  const lookup: Record<string, unknown> = {
    ...(ctx.variables as Record<string, unknown>),
    ticket: ctx.ticket,
    repository: ctx.repository,
    variables: ctx.variables,
  };
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const v = getPath(lookup, path);
    if (v === undefined || v === null) return '';
    if (jsonSafe) return jsonStringFragment(v);
    return typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  });
}

/** ¿El texto contiene algún placeholder `{{...}}`? */
export function hasTemplate(s: string): boolean {
  return /\{\{[^}]+\}\}/.test(s);
}
