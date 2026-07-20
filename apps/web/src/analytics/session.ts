import { SURFACES, type Surface } from '@core/contracts';
import { matchPath } from 'react-router-dom';

/**
 * Sesión de uso (M84). Una sesión es «un rato usando el producto»: se corta sola tras 30 minutos sin
 * actividad, y la comparten las pestañas abiertas del mismo navegador (por eso vive en localStorage y no
 * en sessionStorage: dos pestañas de Workestra son la misma visita, no dos).
 *
 * El navegador NUNCA manda «he terminado». Las sesiones que más importan —cerrar de golpe, quedarse sin
 * batería, mandar el móvil a segundo plano— jamás llegarían a mandarlo. El cierre lo deduce el rollup a
 * partir del primer y el último evento.
 */

const KEY = 'af.analytics.session';
const IDLE_MS = 30 * 60 * 1000;

interface Stored {
  id: string;
  seq: number;
  lastActivity: number;
}

function uuid(): string {
  // `randomUUID` solo existe en contexto seguro; en http://localhost sin TLS hace falta el respaldo.
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  (c?.getRandomValues ?? ((a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256))))(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    return typeof s?.id === 'string' && typeof s.seq === 'number' ? s : null;
  } catch {
    return null; // modo incógnito o almacenamiento lleno: se trabaja sin persistir
  }
}

function write(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* sin persistencia la sesión dura lo que la pestaña; no es motivo para romper nada */
  }
}

/**
 * Devuelve la sesión activa y AVANZA su contador. `seq` es lo que permite ordenar los pasos de un
 * recorrido después: la hora del cliente puede ir torcida y dos pestañas se entrelazan, pero un contador
 * compartido no. Sin esto, montar embudos más adelante sería imposible sin rehacer los datos.
 */
export function nextSeq(): { sessionId: string; seq: number; isNew: boolean } {
  const now = Date.now();
  const cur = read();
  if (!cur || now - cur.lastActivity > IDLE_MS) {
    const fresh: Stored = { id: uuid(), seq: 0, lastActivity: now };
    write(fresh);
    return { sessionId: fresh.id, seq: 0, isNew: true };
  }
  const next: Stored = { id: cur.id, seq: cur.seq + 1, lastActivity: now };
  write(next);
  return { sessionId: next.id, seq: next.seq, isNew: false };
}

/** Marca actividad sin gastar un `seq` (la usa el detector de inactividad). */
export function touch(): void {
  const cur = read();
  if (cur) write({ ...cur, lastActivity: Date.now() });
}

/** Datos de la sesión que solo tiene el navegador. Sin IP y sin el user-agent en crudo (es una huella). */
export function sessionInfo(): { timezone?: string; device?: 'desktop' | 'mobile' | 'tablet'; browser?: string; os?: string } {
  const ua = navigator.userAgent;
  const device = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
  const browser = /Edg\//.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : /Firefox\//.test(ua) ? 'firefox' : 'otro';
  const os = /Windows/.test(ua) ? 'windows' : /Mac OS/.test(ua) ? 'macos' : /Android/.test(ua) ? 'android' : /iPhone|iPad|iOS/.test(ua) ? 'ios' : /Linux/.test(ua) ? 'linux' : 'otro';
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* algunos navegadores endurecidos no lo exponen */
  }
  return { timezone, device, browser, os };
}

/**
 * Convierte una URL en el PATRÓN de ruta. Es el cuello de botella que hace imposible por construcción
 * que se guarde el token de `/invite/:token`, un id en la URL o cualquier query string: lo que sale de
 * aquí solo puede ser uno de los valores del catálogo, y el servidor lo vuelve a comprobar.
 */
export function toSurface(pathname: string): Surface {
  for (const p of SURFACES) {
    if (p === 'unknown') continue;
    if (matchPath(p, pathname)) return p;
  }
  return 'unknown';
}
