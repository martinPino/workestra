/**
 * `RateLimiter`: un Durable Object por clave (ruta + IP) con una ventana deslizante.
 *
 * Existe porque la versión anterior contaba en un `Map` de módulo, cuyo alcance es el ISOLATE. Cloudflare
 * puede atender al mismo atacante desde muchos isolates a la vez, así que el límite real era «10 intentos
 * por minuto POR ISOLATE», es decir, ninguno en la práctica. Un DO serializa sus peticiones y es único
 * globalmente para su nombre, de modo que el contador vuelve a significar lo que dice.
 *
 * La barrera de plataforma (WAF / Rate Limiting Rules) sigue siendo preferible por dos razones: corta
 * ANTES de invocar el Worker —no se paga la petición— y no la puede saturar un atacante. Pero es una
 * función de ZONA y `workers.dev` es la zona de Cloudflare, no del cliente: hasta que haya un dominio
 * propio, esto es la única barrera que puede existir.
 *
 * Se acota a los endpoints de credenciales (login, registro, aceptar invitación, leer un share), que son
 * de bajo volumen. Ahí el salto extra al DO se paga sin problema; ponerlo en todo el API no.
 */

const WINDOW_MS = 60_000;
const DEFAULT_MAX = 10;

export interface DurableStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    setAlarm(when: number): Promise<void>;
    deleteAll(): Promise<void>;
  };
}

export class RateLimiter {
  constructor(private readonly state: DurableStateLike) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/hit') return new Response(null, { status: 404 });

    // El máximo lo fija el llamante: una CUENTA concreta aguanta 10 intentos por minuto, pero una
    // SUBRED entera puede tener muchos usuarios legítimos detrás (NAT corporativa, CGNAT móvil) y
    // aplicarle el mismo número los echaría a todos.
    const max = Number(url.searchParams.get('max')) || DEFAULT_MAX;
    const now = Date.now();
    const previous = (await this.state.storage.get<number[]>('hits')) ?? [];
    const recent = previous.filter((t) => now - t < WINDOW_MS);

    if (recent.length >= max) {
      // No se registra el intento rechazado: si contase, un atacante que siga machacando extendería su
      // propio bloqueo indefinidamente. La ventana debe poder vaciarse dejando de intentarlo.
      const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - recent[0])) / 1000));
      return Response.json({ allowed: false, retryAfter }, { status: 200 });
    }

    recent.push(now);
    await this.state.storage.put('hits', recent);
    // El objeto se borra solo cuando la ventana caduca, para no dejar un DO por cada IP que haya
    // pasado alguna vez. Es el equivalente del `sweep()` que hacía el Map.
    await this.state.storage.setAlarm(now + WINDOW_MS * 2);
    return Response.json({ allowed: true, remaining: max - recent.length }, { status: 200 });
  }

  /** Ventana caducada: el objeto ya no guarda nada útil. */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
