/**
 * Programador en lenguaje natural (M18, movido de Integrations en M53): el usuario elige frecuencia +
 * hora y generamos el patrón cron por debajo; y el camino inverso (cron → texto humano) para las listas.
 * Compartido por el formulario del nodo Trigger (editor) y cualquier otra superficie de horarios.
 */

export type Freq = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly';
export const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']; // cron: 0 = domingo
export const pad2 = (n: number) => String(n).padStart(2, '0');

/** Traduce las selecciones del picker a un patrón cron de 5 campos (min hora díaMes mes díaSem). */
export function buildCron(freq: Freq, everyN: number, hour: number, minute: number, weekday: number, monthday: number): string {
  switch (freq) {
    case 'minutes':
      return `*/${everyN} * * * *`;
    case 'hourly':
      return `${minute} * * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekday}`;
    case 'monthly':
      return `${minute} ${hour} ${monthday} * *`;
    case 'daily':
    default:
      return `${minute} ${hour} * * *`;
  }
}

const isCronInt = (s: string) => /^\d+$/.test(s);

/**
 * Convierte a texto humano SOLO los crons con la forma que genera el picker; cualquier otra forma
 * (rangos «1-5», listas «0,12», pasos «* /5» en hora, etc.) cae con gracia al cron crudo — así un cron
 * legacy escrito a mano nunca se muestra como «NaN» o con un rango mal etiquetado. `t` traduce las piezas.
 */
export function humanCron(cron: string, t: (s: string) => string): string {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [mi, ho, dom, mon, dow] = p;
  // «Cada pocos minutos»: */N * * * *
  const everyN = /^\*\/(\d+)$/.exec(mi);
  if (everyN && ho === '*' && dom === '*' && mon === '*' && dow === '*') return `${t('Cada')} ${everyN[1]} ${t('minutos')}`;
  if (!isCronInt(mi)) return cron;
  // «Cada hora, al minuto N»: N * * * *
  if (ho === '*' && dom === '*' && mon === '*' && dow === '*') return `${t('Cada hora, al minuto')} ${mi}`;
  if (!isCronInt(ho)) return cron;
  const at = `${pad2(Number(ho))}:${pad2(Number(mi))}`;
  // «Cada día a las HH:MM»: N N * * *
  if (dom === '*' && mon === '*' && dow === '*') return `${t('Cada día a las')} ${at}`;
  // «Cada <día de la semana> a las HH:MM»: N N * * D
  if (dom === '*' && mon === '*' && isCronInt(dow) && Number(dow) <= 6) return `${t('Cada')} ${t(WEEKDAYS[Number(dow)])} ${t('a las')} ${at}`;
  // «El día D de cada mes a las HH:MM»: N N D * *
  if (isCronInt(dom) && mon === '*' && dow === '*') return `${t('El día')} ${dom} ${t('de cada mes a las')} ${at}`;
  return cron; // forma no reconocida: cron crudo
}

/** Intervalo en ms → texto humano compacto («cada 15 min»). */
export function humanEvery(ms: number): string {
  if (ms % 3_600_000 === 0) return `cada ${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `cada ${ms / 60_000} min`;
  if (ms % 1_000 === 0) return `cada ${ms / 1_000} s`;
  return `cada ${ms} ms`;
}
