import { ANALYTICS_SCHEMA_VERSION, type AnalyticsEvent } from '@core/contracts';

/**
 * Transporte de eventos (M84). Manda en lotes, reintenta y NUNCA hace esperar a la interfaz.
 *
 * Va con `fetch` a pelo y no con el envoltorio de la app a propósito: ese envoltorio cierra la sesión al
 * recibir un 401, así que un token caducado mientras alguien trabaja convertiría la analítica en el
 * motivo de que le echaran de su propia pantalla. La telemetría jamás puede sacar a nadie de la app.
 */

const API = (import.meta.env.VITE_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const ENDPOINT = `${API}/ingest`;
const QUEUE_KEY = 'af.analytics.queue';

/** Tope del lote: coincide con el que valida el servidor. */
const BATCH = 50;
/** Se acumulan eventos este rato antes de mandar; así una sesión activa no hace una petición por click. */
const FLUSH_MS = 15_000;
/** Cola máxima en memoria/almacenamiento. Pasado esto se tiran los MÁS VIEJOS. */
const MAX_QUEUE = 500;
/** Reintentos con espera creciente. Pasado el último, el lote se descarta: no es un pedido, son métricas. */
const BACKOFF_MS = [2_000, 10_000, 60_000];

let queue: AnalyticsEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending = false;
let failures = 0;
/** Momento a partir del cual se puede volver a intentar. Sin esto, el backoff no lo respetaban ni
 *  `enqueue` (que fuerza flush al llenarse el lote) ni `flushNow`: con la API caída, cada click era otra
 *  petición fallida. */
let nextAttemptAt = 0;

function token(): string | null {
  try {
    const raw = localStorage.getItem('af.auth');
    return raw ? (JSON.parse(raw) as { token?: string }).token ?? null : null;
  } catch {
    return null;
  }
}

/** Persiste la cola: si alguien recarga o se le cae la red, lo pendiente no se pierde. */
function persist(): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
  } catch {
    /* almacenamiento lleno: seguimos solo en memoria */
  }
}

/** Recupera lo que quedó pendiente de una visita anterior. */
export function restoreQueue(): void {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as AnalyticsEvent[];
    if (Array.isArray(saved)) queue = saved.slice(-MAX_QUEUE);
  } catch {
    /* si está corrupto, se empieza de cero: no vale la pena perder tiempo por telemetría */
  }
}

/**
 * Borra lo pendiente y la sesión. Se llama al cerrar sesión: si no, los eventos que A dejó sin enviar los
 * mandaría B al entrar en el mismo navegador, y el servidor los sellaría —correctamente, según su lógica—
 * con el workspace de B. El mecanismo que impide falsificar la atribución se convertiría en el que la
 * falsifica.
 */
export function clearQueue(): void {
  queue = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    localStorage.removeItem(QUEUE_KEY);
    localStorage.removeItem('af.analytics.session');
  } catch {
    /* sin almacenamiento no había nada que limpiar */
  }
}

export function enqueue(ev: AnalyticsEvent): void {
  queue.push(ev);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE); // se sacrifica lo viejo, no lo de ahora
  persist();
  if (queue.length >= BATCH) void flush();
  else schedule();
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_MS);
}

/**
 * Envía un lote. `keepalive` permite que la petición sobreviva a que se cierre la pestaña —que es
 * justo cuando hay que mandar el último trozo de permanencia— y, a diferencia de `sendBeacon`, admite
 * cabeceras, así que el token va donde debe y no dentro del cuerpo.
 */
export async function flush(opts: { keepalive?: boolean } = {}): Promise<void> {
  if (sending || queue.length === 0) return;
  // Se respeta la espera del backoff venga de donde venga la llamada. Al cerrar la pestaña se intenta
  // igualmente: es la última oportunidad de mandar lo que hay y no habrá otra.
  if (!opts.keepalive && Date.now() < nextAttemptAt) return;
  const jwt = token();
  if (!jwt) return; // sin sesión no se ingiere nada: la analítica es de alguien o no es

  const batch = queue.slice(0, BATCH);
  sending = true;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ v: ANALYTICS_SCHEMA_VERSION, events: batch }),
      keepalive: opts.keepalive === true,
    });
    if (res.ok || res.status === 400) {
      // 400 = el servidor rechazó el lote por forma. Reintentarlo daría exactamente el mismo 400 para
      // siempre y bloquearía todo lo que venga detrás, así que se descarta y se sigue.
      queue = queue.slice(batch.length);
      failures = 0;
      nextAttemptAt = 0;
      persist();
      if (queue.length > 0) schedule();
    } else {
      retryLater();
    }
  } catch {
    retryLater(); // sin red: se queda en la cola y se intentará luego (o en la próxima visita)
  } finally {
    sending = false;
  }
}

function retryLater(): void {
  const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
  failures += 1;
  nextAttemptAt = Date.now() + wait;
  if (failures > BACKOFF_MS.length + 2) {
    // La API lleva mucho rato caída. Se deja de insistir y la cola se irá recortando sola por tamaño:
    // acumular horas de eventos para soltarlos de golpe distorsionaría más de lo que aportaría.
    failures = 0;
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, wait);
}

/** Vacía la cola sin esperar. Para el cierre de pestaña y el cambio a segundo plano. */
export function flushNow(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  void flush({ keepalive: true });
}
