/**
 * Etiquetas en lenguaje HUMANO para lo que la máquina llama con jerga (M16 — quick wins no-code).
 * Devuelven la cadena en español (que es la clave i18n); envuelve con `t(...)` en el punto de uso
 * para obtener la traducción inglesa. Un único sitio para que tabla, detalle y editor coincidan.
 */

/** Estado de una ejecución: `SUCCEEDED` → «Completado», `WAITING_HUMAN` → «Esperando tu aprobación». */
export const STATUS_LABEL: Record<string, string> = {
  idle: 'Listo',
  QUEUED: 'En cola',
  RUNNING: 'En curso',
  WAITING_HUMAN: 'Esperando tu aprobación',
  PAUSED: 'En pausa',
  SUCCEEDED: 'Completado',
  FAILED: 'Con error',
  CANCELLED: 'Cancelado',
  UNKNOWN: 'Desconocido',
};

export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status;

/** Qué disparó la ejecución: `webhook` → «Lo disparó una app conectada», `cron` → «Programado». */
export const TRIGGER_LABEL: Record<string, string> = {
  manual: 'Lo lanzaste tú',
  webhook: 'Lo disparó una app conectada',
  cron: 'Programado',
  api: 'Vía API',
  'issue.created': 'Al crear un ticket',
  'issue.updated': 'Al actualizar un ticket',
  'pr.opened': 'Al abrir una propuesta de cambios',
  'pr.merged': 'Al fusionar una propuesta de cambios',
  commit: 'En un cambio de código',
};

export const triggerLabel = (trigger: string): string => TRIGGER_LABEL[trigger] ?? trigger;
