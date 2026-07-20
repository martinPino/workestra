import { z } from 'zod';

/**
 * Product analytics (M84): CÓMO se usa Workestra, no cuánta gente pasa por aquí.
 *
 * Este fichero es la única definición de lo que se puede medir, y vive en contracts porque lo consumen
 * los dos extremos: el navegador que emite y la API que valida. La API NUNCA se fía de lo que llega —
 * revalida cada evento contra este mismo esquema y sobrescribe workspace, usuario y hora de recepción.
 *
 * REGLA DE PRIVACIDAD, y es estructural, no una promesa: en este fichero NO puede aparecer un
 * `z.string()` desnudo. Cada texto es un enum, un `Slug`, un id con forma conocida o un hash. Una lista
 * de claves permitidas dice qué CAMPOS existen y no dice nada de lo que llevan dentro, y justo los dos
 * campos que el producto necesita —la búsqueda y el error— son texto libre. Por eso el permiso se aplica
 * al VALOR. Hay un test que recorre el registro y falla si alguien mete un string sin acotar: sin él,
 * esta regla dura tres sprints.
 */

export const ANALYTICS_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------------------------------
// Vocabularios cerrados
// ---------------------------------------------------------------------------------------------------

/** Identificador corto y sin sorpresas: minúsculas, dígitos y separadores. Nunca texto de una persona. */
const Slug = z.string().regex(/^[a-z0-9._:-]{1,64}$/);
/** Id generado por nosotros (cuid de Prisma). Acota la forma para que no cuele texto libre. */
const EntityId = z.string().regex(/^[a-z0-9_-]{1,40}$/i);

/**
 * PANTALLAS, como PATRÓN de ruta, no como URL. Guardar la URL real metería el token de `/invite/:token`
 * y cualquier query string en la tabla; guardar el patrón lo hace imposible por construcción.
 */
export const SURFACES = [
  '/',
  '/workflows',
  '/workflows/:id',
  '/agents',
  '/executions',
  '/executions/:id',
  '/marketplace',
  '/marketplace/:id',
  '/integrations',
  '/team',
  '/settings',
  '/analytics',
  '/login',
  '/register',
  '/invite/:token',
  'unknown',
] as const;
export const SurfaceSchema = z.enum(SURFACES);
export type Surface = z.infer<typeof SurfaceSchema>;

/** Pestañas del editor de automatizaciones + las que ya existen en Historial. */
export const EDITOR_TABS = ['overview', 'canvas', 'executions', 'logs', 'replay', 'variables', 'knowledge', 'members', 'settings'] as const;
export const TAB_KEYS = [...EDITOR_TABS, 'exec:all', 'exec:ok', 'exec:err', 'exec:reviews'] as const;
export const TabSchema = z.enum(TAB_KEYS);

/** Tipos de cosa a la que puede referirse un evento. El NOMBRE se resuelve al leer, nunca se guarda. */
export const ENTITY_TYPES = ['workflow', 'agent', 'connector', 'template', 'execution', 'node'] as const;
export const EntityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityTypeSchema>;

/**
 * Catálogo de eventos. Cerrado a propósito: un nombre libre se convierte en cardinalidad infinita y en
 * un dashboard que no se puede consultar. Para lo que no encaje está `custom`, con su clave acotada.
 *
 * `workflow.run.*` no estaba en la lista pedida y es el que más falta hacía: sin el RESULTADO de una
 * ejecución, «¿dónde abandona la gente?» no se puede reconstruir después —y no se puede rellenar hacia
 * atrás, porque el evento que no se emitió no existe—. La tabla `Execution` no sirve de sustituto: no
 * tiene `sessionId`, así que no se puede ordenar dentro del recorrido de una persona.
 */
export const EVENT_NAMES = [
  // navegación y permanencia
  'page.viewed',
  'view.ended',
  'tab.changed',
  // automatizaciones
  'workflow.opened',
  'workflow.created',
  'workflow.updated',
  'workflow.deleted',
  'workflow.run.started',
  'workflow.run.succeeded',
  'workflow.run.failed',
  'execution.viewed',
  'replay.viewed',
  // marketplace
  'marketplace.opened',
  'template.installed',
  // conexiones y trabajadores
  'connector.opened',
  'connector.connected',
  'agent.opened',
  'agent.created',
  // resto de la casa
  'team.opened',
  'settings.opened',
  // interacción
  'search.performed',
  'search.selected',
  'filter.applied',
  'modal.opened',
  'modal.closed',
  'button.clicked',
  'error.displayed',
  'custom',
] as const;
export const EventNameSchema = z.enum(EVENT_NAMES);
export type EventName = z.infer<typeof EventNameSchema>;

/** De dónde vino un error. El texto del error NUNCA viaja; ver `error.displayed`. */
export const ERROR_KINDS = ['frontend', 'api', 'workflow', 'connector', 'browser'] as const;
export const ErrorKindSchema = z.enum(ERROR_KINDS);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

/** Dónde se buscó. Cerrado para que el dashboard pueda agrupar. */
export const SEARCH_SCOPES = ['marketplace', 'command-palette', 'workflows', 'agents', 'executions'] as const;

const NoProps = z.object({}).strict();

/**
 * Propiedades permitidas POR EVENTO. Lo que no esté aquí se descarta al validar (`.strict()` + un
 * segundo parseo en el servidor), así que añadir un campo medible es un cambio de contrato con su
 * revisión — que es la única lista de permitidos que sobrevive a los desarrolladores que vengan.
 */
export const EVENT_PROPS = {
  'page.viewed': z.object({ referrerSurface: SurfaceSchema.optional() }).strict(),

  /** Permanencia. `capped` avisa de que el trozo se cerró por el tope, no porque la persona se fuera. */
  'view.ended': z.object({ visibleMs: z.number().int().min(0).max(300_000), capped: z.boolean() }).strict(),

  'tab.changed': z.object({ from: TabSchema.optional() }).strict(),

  /** El resultado de una ejecución. `durationMs` va en el sobre, no aquí. */
  'workflow.run.started': z.object({ trigger: z.enum(['manual', 'cron', 'webhook', 'api']) }).strict(),
  'workflow.run.succeeded': z.object({ nodeCount: z.number().int().min(0).max(1000).optional() }).strict(),
  'workflow.run.failed': z.object({ failedNodeType: Slug.optional() }).strict(),

  // Los cinco tipos del marketplace. Faltaban 'browser' y 'mcp': como el esquema es `.strict()`, un valor
  // fuera del enum tira el evento ENTERO, así que esas dos clases de plantilla habrían quedado sin contar
  // para siempre y sin que nada avisara.
  'template.installed': z.object({ kind: z.enum(['team', 'agent', 'automation', 'browser', 'mcp']).optional() }).strict(),
  'connector.connected': z.object({ provider: Slug }).strict(),

  /**
   * Búsqueda SIN el texto. Lo que se escribe en un buscador puede ser cualquier cosa —el nombre de un
   * cliente, un correo—, así que el día 1 solo viaja un hash con sal por workspace, la longitud en
   * tramos y cuántos resultados salieron. El texto en claro lo materializa el rollup únicamente para
   * las búsquedas que han escrito 5 personas distintas: lo que teclea mucha gente es una señal de
   * producto, lo que teclea una sola persona es de esa persona.
   */
  'search.performed': z.object({
    scope: z.enum(SEARCH_SCOPES),
    queryHash: z.string().regex(/^[0-9a-f]{32}$/),
    queryLenBucket: z.enum(['1-3', '4-8', '9-16', '17-32', '33+']),
    tokenCount: z.number().int().min(0).max(32),
    resultCount: z.number().int().min(0).max(100_000),
  }).strict(),

  /** Cuánto tarda alguien en elegir, y qué puesto eligió: mide si el buscador acierta. */
  'search.selected': z.object({
    scope: z.enum(SEARCH_SCOPES),
    queryHash: z.string().regex(/^[0-9a-f]{32}$/),
    timeToSelectMs: z.number().int().min(0).max(600_000),
    selectedRank: z.number().int().min(0).max(1000),
  }).strict(),

  'filter.applied': z.object({ filter: Slug, value: Slug.optional() }).strict(),
  'modal.opened': z.object({ modal: Slug }).strict(),
  'modal.closed': z.object({ modal: Slug, viaAction: z.boolean().optional() }).strict(),

  /** Clicks: solo los que alguien marcó como importantes con `data-track`. */
  'button.clicked': z.object({ element: Slug }).strict(),

  /**
   * Errores SIN mensaje. El mensaje de error es la vía de fuga clásica: el cliente construye
   * `HTTP <status>: <cuerpo>` con el cuerpo del servidor tal cual, y ahí dentro han llegado a viajar
   * valores de un grafo o trozos de prompt. Por eso aquí solo entra un CÓDIGO conocido: el tipado de
   * `trackError` no admite un `Error` ni un texto (ver el hook), así que no es que esté prohibido,
   * es que no se puede.
   */
  'error.displayed': z.object({
    kind: ErrorKindSchema,
    code: Slug,
    httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict(),

  /** Escape con correa: clave acotada y un valor simple. Nunca texto libre. */
  custom: z.object({ key: Slug, value: z.union([z.number(), z.boolean(), Slug]).optional() }).strict(),
} as const satisfies Partial<Record<EventName, z.ZodTypeAny>>;

/** Props válidas para un evento; sin entrada en el registro, el evento no lleva props. */
export function propsSchemaFor(name: EventName): z.ZodTypeAny {
  return (EVENT_PROPS as Record<string, z.ZodTypeAny>)[name] ?? NoProps;
}

// ---------------------------------------------------------------------------------------------------
// El sobre
// ---------------------------------------------------------------------------------------------------

/**
 * Un evento tal y como lo manda el navegador. El servidor añade `workspaceId`, `userId` y `receivedAt`
 * de la sesión verificada y descarta lo que venga en el cuerpo: si el cliente pudiera decir de qué
 * workspace es un evento, cualquiera podría escribir en la analítica de otro.
 */
export const AnalyticsEventSchema = z
  .object({
    /** Generado al ENCOLAR, no al enviar: un reintento repite el mismo id y no duplica la fila. */
    id: z.string().uuid(),
    /** Reloj del cliente. El servidor lo acota a ±24 h de la recepción: un reloj torcido falsea el DAU. */
    at: z.string().datetime(),
    sessionId: z.string().uuid(),
    /**
     * Orden dentro de la sesión. Es lo que permite montar embudos MÁS ADELANTE sin rehacer nada: la
     * hora del cliente puede ir torcida y dos pestañas se entrelazan, pero esto no.
     */
    seq: z.number().int().min(0),
    name: EventNameSchema,
    surface: SurfaceSchema,
    tab: TabSchema.optional(),
    entityType: EntityTypeSchema.optional(),
    entityId: EntityId.optional(),
    durationMs: z.number().int().min(0).max(300_000).optional(),
    props: z.record(z.unknown()).default({}),
  })
  .strict();
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;

/** Lote. Tope de 50 para que un cliente roto no mande un megabyte por petición. */
export const AnalyticsBatchSchema = z
  .object({
    v: z.literal(ANALYTICS_SCHEMA_VERSION),
    events: z.array(AnalyticsEventSchema).min(1).max(50),
  })
  .strict();
export type AnalyticsBatch = z.infer<typeof AnalyticsBatchSchema>;

/**
 * Valida un evento del todo: sobre + props contra el registro de SU nombre.
 * Se valida evento a evento, no el lote entero: un solo evento inválido no puede tumbar los otros 49,
 * porque el cliente reintentaría el mismo lote envenenado para siempre detrás de su cola.
 */
export function parseAnalyticsEvent(raw: unknown): AnalyticsEvent | null {
  const env = AnalyticsEventSchema.safeParse(raw);
  if (!env.success) return null;
  const props = propsSchemaFor(env.data.name).safeParse(env.data.props);
  if (!props.success) return null;
  return { ...env.data, props: props.data as Record<string, unknown> };
}

// ---------------------------------------------------------------------------------------------------
// Lo que el almacén guarda y devuelve
// ---------------------------------------------------------------------------------------------------

/** Evento ya atribuido por el servidor, listo para escribir. */
export interface StoredAnalyticsEvent extends AnalyticsEvent {
  workspaceId: string;
  userId: string;
  receivedAt: string;
}

/** Datos de la sesión que el navegador aporta una vez. Sin IP y sin el user-agent en crudo. */
export const SessionInfoSchema = z
  .object({
    sessionId: z.string().uuid(),
    timezone: z.string().regex(/^[A-Za-z_+\-/0-9]{1,64}$/).optional(),
    device: z.enum(['desktop', 'mobile', 'tablet']).optional(),
    browser: Slug.optional(),
    os: Slug.optional(),
  })
  .strict();
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

/** Ventana de consulta del dashboard. `workspaceId` es obligatorio: no hay forma de olvidarlo. */
export interface AnalyticsRange {
  /** Workspace concreto, o `ALL` para la vista de plataforma (rama explícita, no un olvido). */
  workspaceId: string | 'ALL';
  from: string;
  to: string;
  limit?: number;
}
