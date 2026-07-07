/**
 * ¿El error de un proveedor LLM es un límite de uso (429 / rate limit / cuota agotada)? Los proveedores
 * lanzan `Error` con el estado HTTP en el mensaje (p. ej. «LLM HTTP 429 …», «Anthropic HTTP 429 …»), y el
 * cuerpo suele incluir «rate limit», «tokens per day/minute», «quota» o «insufficient_quota». Se usa para
 * decidir el FALLBACK a otro proveedor (no reintentar el mismo agotado).
 */
export function isProviderRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\bHTTP 429\b|\b429\b|rate.?limit|too many requests|tokens per (day|minute)|insufficient_quota|\bquota\b/i.test(msg);
}
