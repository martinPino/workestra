/**
 * Catálogo de EVENTOS DE DISPARO en lenguaje natural (triggers sin código, M19). Es el análogo de
 * `connector-providers` pero para la ENTRADA: el usuario elige de esta lista «¿cuándo arranca el flujo?»
 * y AgentFlow traduce por debajo a manual / cron / webhook (y, para apps conectadas, registra el webhook
 * en el proveedor por él). El nodo Trigger del editor se configura desde aquí, sin exponer «webhook»/«cron».
 */

/** Cómo se materializa el disparo por debajo. */
export type TriggerKind = 'manual' | 'schedule' | 'external';

export interface TriggerEventDef {
  /** Id estable, p. ej. 'jira.issue_created'. */
  id: string;
  /** Etiqueta humana (clave i18n en la web), p. ej. «Cuando se crea un ticket de Jira». */
  label: string;
  /** Emoji/pista visual para la tarjeta-receta. */
  icon: string;
  kind: TriggerKind;
  /** Proveedor de conector para los eventos 'external' (p. ej. 'jira'); ausente en manual/schedule. */
  provider?: string;
  /** Eventos REST del proveedor a registrar (p. ej. ['jira:issue_created']). */
  providerEvents?: string[];
  /**
   * Categoría subyacente que debe tener el nodo Trigger del grafo para que el disparo funcione:
   * 'manual' | 'cron' | 'webhook'. Mantiene compatibilidad con triggerEventOf()/el motor existente.
   */
  triggerEvent: 'manual' | 'cron' | 'webhook';
}

export const TRIGGER_EVENTS: TriggerEventDef[] = [
  {
    id: 'manual',
    label: 'Manualmente (yo lo ejecuto)',
    icon: '▶️',
    kind: 'manual',
    triggerEvent: 'manual',
  },
  {
    id: 'schedule',
    label: 'En un horario',
    icon: '🕘',
    kind: 'schedule',
    triggerEvent: 'cron',
  },
  {
    id: 'jira.issue_created',
    label: 'Cuando se crea un ticket de Jira',
    icon: '🎫',
    kind: 'external',
    provider: 'jira',
    providerEvents: ['jira:issue_created'],
    triggerEvent: 'webhook',
  },
  {
    id: 'jira.issue_updated',
    label: 'Cuando se actualiza un ticket de Jira',
    icon: '🔄',
    kind: 'external',
    provider: 'jira',
    providerEvents: ['jira:issue_updated'],
    triggerEvent: 'webhook',
  },
];

export function listTriggerEvents(): TriggerEventDef[] {
  return TRIGGER_EVENTS;
}

export function getTriggerEvent(id: string): TriggerEventDef | null {
  return TRIGGER_EVENTS.find((e) => e.id === id) ?? null;
}
