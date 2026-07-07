/**
 * ¿El error de un proveedor LLM es un límite de uso (429 / rate limit / cuota agotada)? Los proveedores
 * lanzan `Error` con el estado HTTP en el mensaje (p. ej. «LLM HTTP 429 …», «Anthropic HTTP 429 …»), y el
 * cuerpo suele incluir «rate limit», «tokens per day/minute», «quota» o «insufficient_quota». Se usa para
 * decidir el FALLBACK a otro proveedor (no reintentar el mismo agotado).
 */
export function isProviderRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Patrones ANCLADOS al formato real de los proveedores (evita falsos positivos: un 400 de validación
  // cuyo cuerpo/nombre de modelo contenga «quota» o «429» sueltos NO debe disparar fallback de pago).
  return /HTTP 429|rate.?limit|RateLimitError|too many requests|tokens per (day|minute)|insufficient_quota/i.test(msg);
}
