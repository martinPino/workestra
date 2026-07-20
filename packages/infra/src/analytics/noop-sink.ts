import type {
  ActiveUsersRow,
  AnalyticsRange,
  AnalyticsSink,
  EntityRow,
  EntityType,
  ErrorRow,
  EventName,
  FeatureUsageRow,
  FunnelRow,
  RetentionRow,
  SearchRow,
  SessionsRow,
  StoredAnalyticsEvent,
  SurfaceRow,
  TabDwellRow,
} from '@core/contracts';

/**
 * Almacén de analítica que no guarda nada (`PERSISTENCE=memory`).
 *
 * POR QUÉ EXISTE en vez de dejar el puerto sin implementar: el modo sin infra es cómo se levanta el
 * producto en local, y la analítica está instrumentada en TODA la interfaz. Sin este adaptador, arrancar
 * sin Postgres significaría o un puerto nulo que hay que comprobar en cada llamada (y que alguien
 * olvidará comprobar) o una pantalla de dashboard que revienta en desarrollo. Aquí el contrato se cumple
 * entero: la API no distingue este adaptador del de Postgres, simplemente no hay datos.
 *
 * NO acumula los eventos en memoria a propósito: un proceso de desarrollo abierto una tarde entera
 * juntaría cientos de miles de eventos que nadie va a consultar, y sería una fuga de memoria disfrazada
 * de comodidad.
 */
export class NoopAnalyticsSink implements AnalyticsSink {
  /**
   * Se descarta TODO, y se dice: `dropped` lleva el lote entero. Devolver `accepted: n` sería mentirle al
   * cliente —dejaría de reintentar creyendo que se guardó— y taparía en desarrollo el fallo de haber
   * cableado este adaptador donde tocaba el de Postgres.
   */
  async ingest(rows: StoredAnalyticsEvent[]): Promise<{ accepted: number; dropped: number }> {
    return { accepted: 0, dropped: rows.length };
  }

  async topSurfaces(_q: AnalyticsRange): Promise<SurfaceRow[]> {
    return [];
  }

  async tabDwell(_q: AnalyticsRange): Promise<TabDwellRow[]> {
    return [];
  }

  async topEntities(_q: AnalyticsRange & { name: EventName; entityType: EntityType }): Promise<EntityRow[]> {
    return [];
  }

  async activeUsers(_q: AnalyticsRange & { grain: 'day' | 'week' | 'month' }): Promise<ActiveUsersRow[]> {
    return [];
  }

  async retention(_q: AnalyticsRange & { cohortDays: number }): Promise<RetentionRow[]> {
    return [];
  }

  async errors(_q: AnalyticsRange): Promise<ErrorRow[]> {
    return [];
  }

  async searchQuality(_q: AnalyticsRange): Promise<SearchRow[]> {
    return [];
  }

  /** `medianDurationMs` es `null`, no 0: «no hay dato» y «duran cero» son afirmaciones distintas. */
  async sessions(_q: AnalyticsRange): Promise<SessionsRow> {
    return { sessions: 0, users: 0, medianDurationMs: null, eventsPerSession: 0 };
  }

  /**
   * Vacío, y no el inventario con ceros: sin base de datos tampoco hay inventario de funciones que leer,
   * y devolver una lista inventada haría creer al dashboard que nadie usa nada.
   */
  async featureUsage(_q: AnalyticsRange): Promise<FeatureUsageRow[]> {
    return [];
  }

  async funnel(_q: AnalyticsRange & { steps: EventName[]; windowMinutes: number }): Promise<FunnelRow[]> {
    return [];
  }
}
