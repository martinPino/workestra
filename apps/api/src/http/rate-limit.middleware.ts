import type { Context, MiddlewareHandler } from 'hono';
import { HttpError } from './common';
import type { Env } from './env';

/**
 * Rate-limit para los endpoints de credenciales (M73): frena la fuerza bruta de contraseñas y la
 * creación masiva de cuentas. Ventana deslizante contada en un Durable Object.
 *
 * Dos decisiones que vienen de haberlo probado contra el despliegue real, no de la teoría:
 *
 * 1. **El contador vive en un Durable Object, no en un `Map` de módulo.** El alcance de un módulo es el
 *    ISOLATE, y Cloudflare atiende al mismo atacante desde muchos isolates a la vez: el límite efectivo
 *    era «10 por minuto y por isolate», que no limita nada.
 *
 * 2. **Se agrupa por SUBRED, no por IP exacta, y además por SUJETO.** Al probarlo, 13 intentos seguidos
 *    salieron con 13 IPs distintas (`160.79.106.128`…`.139`) porque el proxy de salida rota sobre un
 *    pool — y el límite no saltó ni una vez. Cualquiera con un rango de nube o un botnet tiene eso
 *    gratis, así que una clave por IP exacta es decorativa. Agrupar por /24 (o /64 en IPv6) captura el
 *    pool, y limitar además por el EMAIL al que se apunta protege a una cuenta concreta aunque el ataque
 *    venga repartido.
 *
 * NO sustituye a WAF / Rate Limiting Rules, que cortan antes de invocar el Worker y no se pueden saturar.
 * Pero esas son funciones de ZONA y `workers.dev` es la zona de Cloudflare: hasta que haya un dominio
 * propio, esta es la única barrera que puede existir.
 */

/**
 * Reduce la IP a su bloque de red: /24 en IPv4, /64 en IPv6. Es el nivel al que un atacante consigue
 * direcciones sin esfuerzo —un rango de nube, un proxy de salida— y al que un usuario legítimo rara vez
 * comparte con demasiados otros. Agrupar más (por /16) empezaría a castigar a operadores enteros.
 */
export function networkOf(ip: string): string {
  if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/64`;
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip;
}

/** Una cuenta concreta: estricto, es donde se para la fuerza bruta. */
const SUBJECT_MAX = 10;
/** Una subred entera: holgado, puede haber muchos usuarios legítimos compartiéndola. */
const NETWORK_MAX = 60;

export interface RateLimitOptions {
  /**
   * Identificador de a QUIÉN se ataca (típicamente el email del cuerpo). Se cuenta aparte del origen,
   * de modo que un ataque distribuido contra UNA cuenta también tope. `null` si no se puede determinar.
   */
  subject?: (c: Context<{ Bindings: Env }>) => Promise<string | null>;
}

/**
 * Saca el email del cuerpo como sujeto. Hono cachea el JSON parseado, así que el handler lo vuelve a
 * leer después sin que el cuerpo se haya consumido.
 */
export async function emailSubject(c: Context<{ Bindings: Env }>): Promise<string | null> {
  try {
    const body = await c.req.json<{ email?: string }>();
    const email = body?.email?.trim().toLowerCase();
    return email ? `email:${email}` : null;
  } catch {
    return null;
  }
}

export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    // `CF-Connecting-IP` la pone Cloudflare y NO es falsificable por el cliente, a diferencia de
    // `X-Forwarded-For`, que en el borde puede traer lo que el atacante quiera.
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const path = new URL(c.req.url).pathname;

    // Dos límites con umbrales DISTINTOS a propósito:
    //  - la subred aguanta mucho más, porque puede haber decenas de usuarios legítimos detrás de una
    //    NAT y castigarlos a todos por un atacante sería peor que el ataque;
    //  - la cuenta atacada es estricta, que es donde de verdad se para la fuerza bruta.
    const keys: Array<{ key: string; max: number }> = [
      { key: `${path}|net:${networkOf(ip)}`, max: NETWORK_MAX },
    ];
    const subject = await options.subject?.(c);
    if (subject) keys.push({ key: `${path}|${subject}`, max: SUBJECT_MAX });

    const ns = c.env?.RATE_LIMITER;
    // Sin binding (p. ej. un test que monta el middleware suelto) no se limita, pero se avisa: un
    // rate-limit que no cuenta y no lo dice es peor que no tenerlo, porque aparenta protección.
    if (!ns) {
      console.warn('[rate-limit] falta el binding RATE_LIMITER: la petición NO se está limitando.');
      return next();
    }

    for (const { key, max } of keys) {
      let verdict: { allowed: boolean; retryAfter?: number };
      try {
        const res = await ns.get(ns.idFromName(key)).fetch(`https://do.invalid/hit?max=${max}`, { method: 'POST' });
        verdict = await res.json<{ allowed: boolean; retryAfter?: number }>();
      } catch (e) {
        // FAIL-OPEN deliberado: si el DO no responde estamos ante una incidencia de plataforma, y negar
        // todos los logins haría más daño que dejar pasar intentos durante ese rato. Es la misma
        // decisión que toma la revalidación de cuenta en `auth.middleware.ts` ante un fallo de BD.
        console.error('[rate-limit] el DO no respondió; se deja pasar:', e instanceof Error ? e.message : String(e));
        continue;
      }

      if (!verdict.allowed) {
        throw new HttpError(429, {
          statusCode: 429,
          message: 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.',
          error: 'TooManyRequests',
          retryAfter: verdict.retryAfter ?? 60,
        });
      }
    }

    return next();
  };
}
