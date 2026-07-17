/**
 * Referencias `{{...}}` que NO salen de ningún paso, sino que las provee el propio motor (M82).
 *
 * Vive en contracts porque la regla la necesitan DOS lados que no pueden importarse entre sí: el runtime que
 * la resuelve (`@core/sdk-plugins`) y el editor que valida lo que escribes (`apps/web`). Con la regla escrita
 * dos veces, el editor pintaba en rojo —«referencia a un paso que no existe»— algo que el motor resolvía
 * perfectamente. Un aviso falso es peor que ninguno: enseña a ignorar los verdaderos.
 */

/**
 * Fecha relativa al momento de la ejecución: `{{fecha}}`, `{{fecha:-1d}}`, `{{fecha:-36h}}`, `{{fecha:+7d}}`,
 * `{{fecha:-1d.date}}`. Unidades: `s`egundos, `m`inutos, `h`oras, `d`ías.
 *
 * Existe porque medio mundo filtra por tiempo (`?from=`, `?since=`) y un flujo que corre cada día necesita
 * «ayer», no una fecha fija que se queda vieja el segundo día.
 */
export const DATE_REF_RE = /^fecha(?::([+-]\d+)([smhd]))?(?:\.(date|iso))?$/;

/** ¿El token de un `{{...}}` es una fecha del motor? `fecha` es palabra reservada: gana a cualquier variable. */
export function isDateRef(token: string): boolean {
  return DATE_REF_RE.test(token.trim());
}
