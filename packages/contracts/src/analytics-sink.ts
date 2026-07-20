import type { AnalyticsRange, EntityType, EventName, StoredAnalyticsEvent } from './analytics';

/**
 * Puerto del almacén de analítica (M84). Existe para que cambiar Postgres por un motor columnar sea un
 * adaptador nuevo y nada más.
 *
 * Lleva LECTURA además de escritura a propósito: un puerto que solo sabe escribir obliga a que el
 * dashboard hable SQL directamente, y entonces cambiar de motor es reescribir el dashboard. Las
 * consultas son con nombre —nunca SQL desde fuera— y todas piden el rango, que a su vez exige el
 * workspace.
 *
 * DÓNDE VIVE: en contracts, como interfaz pura. No entra en `PersistenceBundle` porque los puertos de
 * ese paquete son del motor de ejecución y la analítica de producto no lo es; se inyecta con su propio
 * token de Nest, que es la misma convención un piso más arriba.
 */
export interface AnalyticsSink {
  /** Escribe un lote ya atribuido. Idempotente por `(at, id)`: reintentar no duplica. */
  ingest(rows: StoredAnalyticsEvent[]): Promise<{ accepted: number; dropped: number }>;

  /** Pantallas y pestañas más usadas, con su permanencia. */
  topSurfaces(q: AnalyticsRange): Promise<SurfaceRow[]>;
  tabDwell(q: AnalyticsRange): Promise<TabDwellRow[]>;

  /** Lo más tocado de un tipo: automatizaciones editadas, conectores, plantillas… */
  topEntities(q: AnalyticsRange & { name: EventName; entityType: EntityType }): Promise<EntityRow[]>;

  /** Personas activas por día/semana/mes. Exacto, desde la tabla de conjuntos. */
  activeUsers(q: AnalyticsRange & { grain: 'day' | 'week' | 'month' }): Promise<ActiveUsersRow[]>;
  /** Retención por cohorte de alta. */
  retention(q: AnalyticsRange & { cohortDays: number }): Promise<RetentionRow[]>;

  errors(q: AnalyticsRange): Promise<ErrorRow[]>;
  searchQuality(q: AnalyticsRange): Promise<SearchRow[]>;
  sessions(q: AnalyticsRange): Promise<SessionsRow>;

  /**
   * Uso por FUNCIÓN, cruzado contra el inventario. Es la única que puede responder «¿qué no usa casi
   * nadie?»: una función que no se dispara nunca no deja filas, así que sin el inventario enfrente es
   * invisible. Por eso devuelve también los ceros.
   */
  featureUsage(q: AnalyticsRange): Promise<FeatureUsageRow[]>;

  /** Embudo por pasos, dentro de una misma sesión y en orden de `seq`. */
  funnel(q: AnalyticsRange & { steps: EventName[]; windowMinutes: number }): Promise<FunnelRow[]>;
}

export interface SurfaceRow {
  surface: string;
  views: number;
  sessions: number;
  dwellMs: number;
  /** Denominador PROPIO. La media es `dwellMs / dwellSamples`, nunca `dwellMs / views`: dividir por las
   *  vistas mete en el denominador eventos de duración cero y hunde la media sin que se note. */
  dwellSamples: number;
}

export interface TabDwellRow extends SurfaceRow {
  tab: string;
}

export interface EntityRow {
  entityId: string;
  count: number;
  /** Nombre legible, resuelto AL LEER contra la tabla viva. Nunca se guarda en el evento. */
  label?: string;
}

export interface ActiveUsersRow {
  bucket: string;
  users: number;
  sessions: number;
}

export interface RetentionRow {
  cohort: string;
  dayOffset: number;
  cohortSize: number;
  retained: number;
}

export interface ErrorRow {
  kind: string;
  code: string;
  count: number;
  users: number;
}

export interface SearchRow {
  scope: string;
  searches: number;
  /** Búsquedas que no dieron ningún resultado: el mejor indicador de qué falta en el producto. */
  zeroResults: number;
  selections: number;
  medianTimeToSelectMs: number | null;
  /** Solo las tecleadas por 5+ personas distintas (ver el comentario de `search.performed`). */
  topTerms: Array<{ text: string; users: number; searches: number }>;
}

export interface SessionsRow {
  sessions: number;
  users: number;
  medianDurationMs: number | null;
  eventsPerSession: number;
}

export interface FeatureUsageRow {
  kind: string;
  key: string;
  label: string;
  count: number;
  users: number;
  /** Desde cuándo está medida. Distingue «no la usa nadie» de «no la hemos instrumentado». */
  instrumentedSince: string;
}

export interface FunnelRow {
  step: string;
  stepIndex: number;
  users: number;
  /** Porcentaje que llega desde el paso anterior. */
  conversionFromPrev: number;
}
