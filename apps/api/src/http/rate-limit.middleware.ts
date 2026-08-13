import type { MiddlewareHandler } from 'hono';
import { HttpError } from './common';

/**
 * Rate-limit para los endpoints de credenciales (M73): port de `AuthRateLimitGuard`. Frena la fuerza
 * bruta de contraseñas y la creación masiva de cuentas. Ventana deslizante por IP + ruta.
 *
 * El mapa vive a nivel de MÓDULO, así que su alcance es el isolate, no el proceso. Eso lo hace MÁS
 * débil que en Railway: Cloudflare puede atender a un mismo atacante desde varios isolates y cada uno
 * lleva su cuenta. Sigue siendo defensa en profundidad —nunca fue la única barrera, el comentario
 * original ya decía que el borde debe imponer la suya— pero en Cloudflare la barrera de verdad es WAF
 * o Rate Limiting Rules, que sí son globales. **Configúralas antes de apagar Railway.**
 */
const hits = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX = 10; // intentos por IP y ruta por minuto

export function rateLimit(): MiddlewareHandler {
  return async (c, next) => {
    // `CF-Connecting-IP` es la IP real que pone Cloudflare y NO es falsificable por el cliente, a
    // diferencia de `X-Forwarded-For`, que en el borde puede venir con lo que el atacante quiera.
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const key = `${new URL(c.req.url).pathname}:${ip}`;
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

    if (recent.length >= MAX) {
      throw new HttpError(429, 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.');
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) sweep(now); // evita crecimiento ilimitado del mapa
    return next();
  };
}

function sweep(now: number): void {
  for (const [k, v] of hits) {
    const fresh = v.filter((t) => now - t < WINDOW_MS);
    if (fresh.length === 0) hits.delete(k);
    else hits.set(k, fresh);
  }
}

/** Vacía el mapa. Solo para tests. */
export function __resetRateLimit(): void {
  hits.clear();
}
