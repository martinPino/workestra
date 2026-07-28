/**
 * ¿El error de un proveedor LLM significa «este proveedor no puede atenderme, prueba con el siguiente»?
 * Se usa para decidir el FALLBACK a otro proveedor de la cadena (M33).
 *
 * Cubre TRES familias, porque las tres dejan al proveedor igual de inservible y la siguiente clave del
 * llavero sí puede funcionar:
 *   1. LÍMITE DE USO — 429, rate limit, tokens por día/minuto.
 *   2. SALDO AGOTADO — el caso que rompía la cadena en producción: Anthropic devuelve la falta de crédito
 *      como HTTP **400** («Your credit balance is too low…»), no como 429, así que se trataba como error
 *      fatal y la cadena moría ahí en vez de seguir hasta un proveedor con saldo.
 *   3. CREDENCIAL RECHAZADA — 401/403. Una clave revocada en un proveedor no dice nada de los demás.
 *
 * Lo que NO debe entrar (y por eso los patrones van anclados al formato real de los mensajes): un 400 de
 * VALIDACIÓN cuyo cuerpo o nombre de modelo contenga «quota» o «429» sueltos. Ese error es culpa de la
 * petición, se repetiría idéntico en los cuatro proveedores, y enmascararlo tras cuatro intentos solo
 * retrasaría el diagnóstico. Si todos los eslabones fallan, `chat` lanza el último error, así que una
 * credencial rota sigue saliendo a la luz.
 */
const LIMITE_DE_USO = /HTTP 429|rate.?limit|RateLimitError|too many requests|tokens per (day|minute)|insufficient_quota/i;
const SALDO_AGOTADO = /HTTP 402|credit balance|exceeded your current quota|payment required|billing details/i;
const CREDENCIAL_RECHAZADA = /HTTP 40[13]\b|invalid.?api.?key|authentication.?error|permission.?denied|unauthorized/i;

export function isProviderUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return LIMITE_DE_USO.test(msg) || SALDO_AGOTADO.test(msg) || CREDENCIAL_RECHAZADA.test(msg);
}
