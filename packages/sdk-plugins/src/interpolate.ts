import type { ExecutionContext } from '@core/contracts';

/**
 * Lee `path` (dot-notation) de un objeto. Las claves de variable pueden contener `:` e incluso `.`
 * (p. ej. `connector:c`, o un nodo cuya key es `read.msg` → variable `connector:read.msg`), así que
 * en cada nivel se prueba el prefijo de segmentos MÁS LARGO que sea una propiedad PROPIA del objeto
 * antes de descender. Solo se leen propiedades propias: nunca la cadena de prototipos, de modo que
 * `{{toString}}`, `{{constructor}}`, `{{__proto__}}`, etc. resuelven a `undefined` (no a funciones
 * heredadas ni a `Object.prototype`) y no rompen la interpolación.
 */
export function getPath(root: unknown, path: string): unknown {
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

/**
 * Fechas relativas al momento de la ejecución (M82): `{{fecha}}`, `{{fecha:-1d}}`, `{{fecha:-36h}}`,
 * `{{fecha:+7d}}`. Se resuelve ANTES que el contexto, así que `fecha` es una palabra reservada.
 *
 * Existe porque medio mundo filtra por tiempo (`?from=`, `?since=`, `updated >= ...`) y un flujo que corre
 * cada día necesita «ayer», no una fecha fija que se queda vieja el segundo día. Sin esto, la única
 * alternativa es una ventana sin fecha —«lo más reciente»— que en una fuente con volumen es un ojo de
 * cerradura de minutos.
 *
 * Formato ISO-8601 en UTC sin milisegundos (`2026-07-16T11:30:00`), que es lo que aceptan las APIs
 * habituales. `.date` da solo `2026-07-16` para las que quieren día suelto.
 */
const FECHA_RE = /^fecha(?::([+-]\d+)([smhd]))?(?:\.(date|iso))?$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function resolveFecha(path: string, now: number): string | undefined {
  const m = FECHA_RE.exec(path.trim());
  if (!m) return undefined;
  const [, amount, unit, fmt] = m;
  const at = new Date(now + (amount ? Number(amount) * UNIT_MS[unit] : 0));
  // Un desplazamiento fuera del rango de Date (`{{fecha:+99999999d}}` ya roza el límite) haría que
  // `toISOString()` lanzara. Toda ref inválida degrada a '' en el resto de la interpolación; esta —que está
  // en el camino de CADA nodo— no va a ser la única que tumbe un flujo por un cero de más.
  if (!Number.isFinite(at.getTime())) return '';
  const iso = at.toISOString();
  return fmt === 'date' ? iso.slice(0, 10) : iso.slice(0, 19);
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
export function interpolate(template: string, ctx: ExecutionContext, jsonSafe = false, now: number = Date.now()): string {
  const lookup: Record<string, unknown> = {
    ...(ctx.variables as Record<string, unknown>),
    ticket: ctx.ticket,
    repository: ctx.repository,
    variables: ctx.variables,
  };
  // Un `fecha` en las variables NO puede sombrear la palabra reservada: el mismo texto debe dar la misma
  // fecha en cualquier flujo, venga de donde venga el contexto.
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const fecha = resolveFecha(path, now);
    if (fecha !== undefined) return jsonSafe ? jsonStringFragment(fecha) : fecha;
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
