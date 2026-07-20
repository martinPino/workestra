import type { AnalyticsEvent, EntityType, ErrorKind, EventName, Surface } from '@core/contracts';
import { nextSeq, touch, toSurface } from './session';
import { clearQueue, enqueue, flushNow, restoreQueue } from './transport';

/**
 * Núcleo del seguimiento (M84): emitir eventos y medir cuánto se está en cada sitio.
 *
 * Todo lo de aquí es «dispara y olvida»: si algo falla, falla en silencio. La analítica nunca puede
 * romper una pantalla ni hacer esperar a nadie.
 */

/** Cierra el trozo si no hay actividad en este rato. Una pestaña olvidada deja de contar. */
const IDLE_MS = 60_000;
/** Tope por trozo. Deliberadamente ALTO: un tope de 30 s emitiría 2 eventos/min por cada pestaña abierta,
 *  esté alguien delante o no, y ese suelo se come el volumen entero. Con el corte por inactividad, una
 *  pestaña desatendida manda un trozo y se calla. */
const CAP_MS = 5 * 60_000;
const TICK_MS = 5_000;

interface View {
  surface: Surface;
  tab?: string;
  /** Milisegundos acumulados de presencia REAL (visible + actividad reciente). */
  accumulated: number;
  /** Momento en que arrancó el tramo actual, o null si el reloj está parado. */
  since: number | null;
  lastActivity: number;
}

let view: View | null = null;
let started = false;
let lastEmit = 0;
/**
 * Compuerta general (M84). Empieza APAGADA y solo la abre el servidor: mientras esté cerrada no se emite
 * nada, no se arranca el reloj de permanencia y no se escucha ningún evento del documento.
 *
 * Apagarlo solo en el servidor ahorraría el almacenamiento; apagarlo AQUÍ ahorra además el trabajo en el
 * dispositivo de quien usa el producto y su batería, que es de quien no es el dato.
 */
let enabled = false;

function now(): number {
  return Date.now();
}

/** Suma el tramo en curso y para el reloj. */
function pause(): void {
  if (!view || view.since === null) return;
  view.accumulated += now() - view.since;
  view.since = null;
}

function resume(): void {
  if (!view || view.since !== null) return;
  if (document.visibilityState !== 'visible') return;
  view.since = now();
}

/** Emite lo acumulado y deja el contador a cero (el trozo se cierra, la vista puede seguir). */
function emitPartial(capped: boolean): void {
  if (!view) return;
  pause();
  const ms = Math.round(view.accumulated);
  view.accumulated = 0;
  if (ms < 1000) return; // menos de un segundo no es permanencia, es ruido
  track('view.ended', {
    surface: view.surface,
    tab: view.tab,
    durationMs: Math.min(ms, CAP_MS),
    props: { visibleMs: Math.min(ms, CAP_MS), capped },
  });
}

/** Cambia de pantalla o de pestaña: cierra lo anterior y abre lo nuevo. */
export function startView(surface: Surface, tab?: string): void {
  if (view && view.surface === surface && view.tab === tab) return;
  // Una llamada SIN pestaña sobre la pantalla que ya está abierta CON pestaña no la cierra: es el efecto
  // de ruta del proveedor llegando después de que la pantalla hija abriera su pestaña. Sin esto, la
  // pestaña por defecto de cada pantalla con pestañas no acumulaba tiempo nunca y parecía la menos usada.
  if (view && view.surface === surface && tab === undefined && view.tab !== undefined) return;
  if (view) emitPartial(false);
  view = { surface, tab, accumulated: 0, since: null, lastActivity: now() };
  resume();
}

export function endView(): void {
  if (!view) return;
  emitPartial(false);
  view = null;
}

/** Evento genérico. Todo lo demás pasa por aquí. */
export function track(
  name: EventName,
  opts: {
    surface?: Surface;
    tab?: string;
    entityType?: EntityType;
    entityId?: string;
    durationMs?: number;
    props?: Record<string, unknown>;
  } = {},
): void {
  if (!enabled) return;
  try {
    const { sessionId, seq } = nextSeq();
    const ev: AnalyticsEvent = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${sessionId}-${seq}-${now()}`,
      at: new Date().toISOString(),
      sessionId,
      seq,
      name,
      surface: opts.surface ?? view?.surface ?? toSurface(location.pathname),
      tab: opts.tab as AnalyticsEvent['tab'],
      entityType: opts.entityType,
      entityId: opts.entityId,
      durationMs: opts.durationMs,
      props: opts.props ?? {},
    };
    lastEmit = now();
    enqueue(ev);
  } catch {
    /* la telemetría jamás rompe una pantalla */
  }
}

/**
 * Arranca el seguimiento. Idempotente: en desarrollo React monta dos veces con StrictMode y sin esto
 * habría dos relojes y dos juegos de escuchas contando lo mismo.
 */
export function startTracking(): () => void {
  if (started || !enabled) return () => {};
  started = true;
  restoreQueue();

  // Actividad: limitada a una marca cada 5 s para no hacer trabajo en cada píxel de scroll.
  let lastTouch = 0;
  const onActivity = (): void => {
    const t = now();
    if (t - lastTouch < 5_000) return;
    lastTouch = t;
    touch();
    if (view) {
      view.lastActivity = t;
      resume();
    }
  };
  const acts: Array<keyof DocumentEventMap> = ['pointerdown', 'keydown', 'scroll', 'wheel'];
  for (const e of acts) document.addEventListener(e, onActivity, { passive: true, capture: true });

  // Ni `beforeunload` ni `unload` son de fiar. `visibilitychange` y `pagehide` sí disparan al cerrar la
  // pestaña, al cambiar de pestaña y al mandar el móvil a segundo plano, que es donde se pierde la gente.
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      emitPartial(false);
      flushNow();
    } else if (view) {
      view.lastActivity = now();
      resume();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  const onHide = (): void => {
    emitPartial(false);
    flushNow();
  };
  window.addEventListener('pagehide', onHide);

  const tick = setInterval(() => {
    if (!view) return;
    const t = now();
    // Sin actividad reciente: se cierra el trozo y se para el reloj hasta que alguien vuelva.
    if (view.since !== null && t - view.lastActivity > IDLE_MS) {
      emitPartial(false);
      return;
    }
    // Tramo demasiado largo: se corta y se marca, para no perderlo todo si el navegador muere.
    if (view.since !== null && view.accumulated + (t - view.since) >= CAP_MS) emitPartial(true);
  }, TICK_MS);

  return () => {
    for (const e of acts) document.removeEventListener(e, onActivity, { capture: true } as EventListenerOptions);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onHide);
    clearInterval(tick);
    started = false;
  };
}

/**
 * Abre o cierra la compuerta. Lo llama el proveedor con lo que dice el servidor.
 * Al cerrarla se tira lo que hubiera pendiente: si se apagó la recogida, lo ya recogido tampoco se manda.
 */
export function setEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  if (!on) {
    view = null;
    clearQueue();
  }
}

export function isEnabled(): boolean {
  return enabled;
}

/** Último evento emitido (para pruebas manuales desde la consola). */
export function lastEmitAt(): number {
  return lastEmit;
}

// --- Ayudas con forma de dominio ------------------------------------------------------------------

/** Longitud en tramos: mide si la gente escribe poco o mucho SIN guardar lo que escribió. */
export function lenBucket(n: number): '1-3' | '4-8' | '9-16' | '17-32' | '33+' {
  if (n <= 3) return '1-3';
  if (n <= 8) return '4-8';
  if (n <= 16) return '9-16';
  if (n <= 32) return '17-32';
  return '33+';
}

/**
 * Hash de una búsqueda. NO es un secreto: el corpus es pequeño y está al lado, así que quien tenga la
 * base de datos podría revertirlo por fuerza bruta. Es una CLAVE DE CORRELACIÓN, para poder contar
 * cuánta gente distinta busca lo mismo; lo que protege de verdad es el umbral de 5 personas que aplica
 * el rollup antes de materializar ningún texto.
 */
export async function hashQuery(q: string): Promise<string> {
  const norm = q.trim().toLowerCase().replace(/\s+/g, ' ');
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
    return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Sin WebCrypto (http sin TLS): un hash flojo pero de la MISMA forma, para no romper el esquema.
    let h = 0;
    for (let i = 0; i < norm.length; i++) h = (Math.imul(31, h) + norm.charCodeAt(i)) | 0;
    return Math.abs(h).toString(16).padStart(32, '0').slice(0, 32);
  }
}

export type { ErrorKind };
