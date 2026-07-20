import { Prisma, type PrismaClient } from '@prisma/client';
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
 * Adaptador Postgres del puerto de analítica de producto (M84).
 *
 * REGLA QUE MANDA SOBRE TODAS: las lecturas salen de los ROLLUPS, nunca de `AnalyticsEvent`. La tabla
 * cruda se escribe a chorro y crece sin techo; una consulta del dashboard que la barra funciona el primer
 * mes y tumba la base el sexto, justo cuando ya nadie recuerda por qué. La ÚNICA excepción es `funnel()`,
 * y está marcada como tal ahí abajo.
 *
 * CONVENIO CON EL ROLLUP (esto es contrato entre este fichero y el job que sella las horas; si el job
 * escribe otra cosa, estas lecturas devuelven ceros en silencio, que es el peor fallo posible):
 *  - `error.displayed` → `entityType = props.kind`, `entityId = props.code`. El rollup no tiene columnas
 *    propias para el error, y meter el par en la dimensión de entidad evita añadir una tabla por evento.
 *  - `search.performed` / `search.selected` → `entityType = 'search'`, `entityId = props.scope`.
 *  - Las búsquedas con `resultCount = 0` llevan ADEMÁS una fila gemela con `name = 'search.zero'` (y el
 *    mismo `entityType = 'search'`): el «no encontré nada» es la señal más valiosa del buscador y no se
 *    puede deducir de un contador. Lo que distingue a la gemela es el NOMBRE y no el tipo de entidad
 *    justamente para que nadie que agregue por `name` la cuente como una búsqueda más.
 *  - `AnalyticsFeature.kind = 'event'` cruza contra `AnalyticsHourlyEvent.name`; `kind = 'surface'` y
 *    `kind = 'tab'` cruzan contra `AnalyticsHourlyView` (`surface` / `tab`), que es donde vive de verdad
 *    su uso — NO contra la dimensión de entidad, que para ellos está siempre vacía.
 *
 * Sin decoradores ni nada de Nest: el `PrismaClient` entra por constructor, igual que el resto de
 * adaptadores de este paquete, para que el puerto se pueda instanciar en un test sin contenedor de DI.
 */
export class PostgresAnalyticsSink implements AnalyticsSink {
  constructor(private readonly prisma: PrismaClient) {}

  // -------------------------------------------------------------------------------------------------
  // Escritura
  // -------------------------------------------------------------------------------------------------

  /**
   * `skipDuplicates` NO es una optimización: es lo que hace segura la entrega at-least-once. El cliente
   * reintenta un lote cuando la red se corta a medio camino, y la PK `(at, id)` —con el `id` generado al
   * ENCOLAR, no al enviar— convierte ese reintento en cero filas nuevas en vez de en un DAU inflado.
   */
  async ingest(rows: StoredAnalyticsEvent[]): Promise<{ accepted: number; dropped: number }> {
    if (rows.length === 0) return { accepted: 0, dropped: 0 };

    const data = rows.map((e) => ({
      at: new Date(e.at),
      id: e.id,
      receivedAt: new Date(e.receivedAt),
      workspaceId: e.workspaceId,
      userId: e.userId,
      sessionId: e.sessionId,
      seq: e.seq,
      name: e.name,
      surface: e.surface,
      // Las dimensiones opcionales van a '' y no a NULL: forman parte de la PK de los rollups, y en
      // Postgres NULL nunca es igual a NULL, así que un NULL aquí rompería el upsert de la hora.
      tab: e.tab ?? '',
      entityType: e.entityType ?? '',
      entityId: e.entityId ?? '',
      durationMs: e.durationMs ?? null,
      props: (e.props ?? {}) as Prisma.InputJsonValue,
    }));

    const { count } = await this.prisma.analyticsEvent.createMany({ data, skipDuplicates: true });
    // `dropped` son duplicados, no errores: es la métrica que dice si el cliente está reintentando de más.
    return { accepted: count, dropped: rows.length - count };
  }

  // -------------------------------------------------------------------------------------------------
  // Utilidades comunes
  // -------------------------------------------------------------------------------------------------

  /**
   * FILTRO DE TENANT. Se usa en TODAS las consultas sin excepción: el fallo más caro que puede tener este
   * fichero es una lectura sin acotar, porque no revienta —devuelve datos de otros workspaces con toda
   * naturalidad—. `'ALL'` es la vista de plataforma y es una rama EXPLÍCITA: así un `workspaceId` que
   * llegue vacío por descuido no se parece a la vista global, simplemente no encuentra nada.
   *
   * `alias` nunca viene de fuera; son literales escritos aquí, por eso puede ir por `Prisma.raw`. Todo lo
   * que sí viene de fuera va SIEMPRE por parámetro enlazado.
   */
  private wsFilter(q: AnalyticsRange, alias = 't'): Prisma.Sql {
    const col = Prisma.raw(`"${alias}"."workspaceId"`);
    return q.workspaceId === 'ALL' ? Prisma.sql`TRUE` : Prisma.sql`${col} = ${q.workspaceId}`;
  }

  /** Ventana [from, to). Medio abierta a propósito: días contiguos no se solapan ni pierden una hora. */
  private range(q: AnalyticsRange, col: string, alias = 't'): Prisma.Sql {
    const c = Prisma.raw(`"${alias}"."${col}"`);
    return Prisma.sql`${c} >= ${new Date(q.from)} AND ${c} < ${new Date(q.to)}`;
  }

  /** Tope de filas. Acotado arriba porque un `limit` enorme desde la API es un DoS gratis. */
  private limitOf(q: AnalyticsRange, fallback = 20): number {
    const n = Number(q.limit ?? fallback);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), 500);
  }

  // -------------------------------------------------------------------------------------------------
  // Navegación y permanencia
  // -------------------------------------------------------------------------------------------------

  /**
   * Pantallas más vistas. Suma las horas selladas de `AnalyticsHourlyView` colapsando la pestaña: una
   * pantalla sin pestañas y otra con seis tienen que ser comparables.
   *
   * `sessions` es una SUMA de sesiones-por-hora, no sesiones únicas: una sesión que cruza la medianoche
   * cuenta dos veces. Es el precio de que el rollup sea aditivo, y es el número correcto para «cuánto
   * tráfico tiene esta pantalla»; para sesiones únicas de verdad está `sessions()`, que lee la tabla de
   * sesiones.
   */
  async topSurfaces(q: AnalyticsRange): Promise<SurfaceRow[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT t."surface"            AS surface,
             SUM(t."views")         AS views,
             SUM(t."sessions")      AS sessions,
             SUM(t."dwellMs")       AS "dwellMs",
             SUM(t."dwellSamples")  AS "dwellSamples"
        FROM "AnalyticsHourlyView" t
       WHERE ${this.wsFilter(q)} AND ${this.range(q, 'hour')}
       GROUP BY t."surface"
       ORDER BY views DESC
       LIMIT ${this.limitOf(q)}
    `);
    return rows.map((r) => ({
      surface: str(r.surface),
      views: num(r.views),
      sessions: num(r.sessions),
      dwellMs: num(r.dwellMs),
      dwellSamples: num(r.dwellSamples),
    }));
  }

  /**
   * Permanencia por PESTAÑA. Descarta `tab = ''` (la vista sin pestañas) porque aquí la pregunta es
   * exactamente cuál de las pestañas del editor mira la gente y cuál no abre nadie.
   *
   * Ordena por permanencia MEDIA —`dwellMs / dwellSamples`— y no por vistas: una pestaña que se abre por
   * error mil veces y se cierra al instante no es una pestaña que se use. El denominador es el propio
   * `dwellSamples`, jamás `views`: dividir por las vistas mete en el denominador los eventos de duración
   * cero y hunde la media sin que se note en el número.
   */
  async tabDwell(q: AnalyticsRange): Promise<TabDwellRow[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT t."surface"            AS surface,
             t."tab"                AS tab,
             SUM(t."views")         AS views,
             SUM(t."sessions")      AS sessions,
             SUM(t."dwellMs")       AS "dwellMs",
             SUM(t."dwellSamples")  AS "dwellSamples"
        FROM "AnalyticsHourlyView" t
       WHERE ${this.wsFilter(q)} AND ${this.range(q, 'hour')} AND t."tab" <> ''
       GROUP BY t."surface", t."tab"
       ORDER BY SUM(t."dwellMs") / NULLIF(SUM(t."dwellSamples"), 0) DESC NULLS LAST
       LIMIT ${this.limitOf(q)}
    `);
    return rows.map((r) => ({
      surface: str(r.surface),
      tab: str(r.tab),
      views: num(r.views),
      sessions: num(r.sessions),
      dwellMs: num(r.dwellMs),
      dwellSamples: num(r.dwellSamples),
    }));
  }

  // -------------------------------------------------------------------------------------------------
  // Entidades
  // -------------------------------------------------------------------------------------------------

  /**
   * Lo más tocado de un tipo. Devuelve el ID a secas y `label` sin definir A PROPÓSITO: el nombre legible
   * se resuelve AL LEER contra la tabla viva (la API cruza estos ids con `Workflow`, `Agent`…). Guardar el
   * nombre en la analítica lo convertiría en una copia que envejece —y que sobrevive al borrado de la
   * cosa nombrada, que es justo lo que la promesa de privacidad dice que no pasa—.
   */
  async topEntities(q: AnalyticsRange & { name: EventName; entityType: EntityType }): Promise<EntityRow[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT t."entityId" AS "entityId", SUM(t."count") AS count
        FROM "AnalyticsHourlyEvent" t
       WHERE ${this.wsFilter(q)} AND ${this.range(q, 'hour')}
         AND t."name" = ${q.name} AND t."entityType" = ${q.entityType} AND t."entityId" <> ''
       GROUP BY t."entityId"
       ORDER BY count DESC
       LIMIT ${this.limitOf(q)}
    `);
    return rows.map((r) => ({ entityId: str(r.entityId), count: num(r.count) }));
  }

  // -------------------------------------------------------------------------------------------------
  // Personas
  // -------------------------------------------------------------------------------------------------

  /**
   * DAU/WAU/MAU EXACTOS. Sale de `AnalyticsUserDay` y no de sumar rollups horarios porque los únicos no
   * se pueden sumar: quien entra a las 9 y a las 18 es una persona, no dos. `date_trunc` agrupa los días
   * en la ventana pedida, así que la semana es la semana ISO de Postgres (empieza en lunes).
   *
   * `sessions` sí es aditivo y se suma tal cual.
   */
  async activeUsers(q: AnalyticsRange & { grain: 'day' | 'week' | 'month' }): Promise<ActiveUsersRow[]> {
    // Lista blanca aunque el tipo ya lo acote: el tipado desaparece en runtime y esto entra en un SQL.
    const grain = q.grain === 'week' ? 'week' : q.grain === 'month' ? 'month' : 'day';
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT to_char(date_trunc(${grain}, t."day"::timestamp), 'YYYY-MM-DD') AS bucket,
             COUNT(DISTINCT t."userId")                                      AS users,
             SUM(t."sessions")                                               AS sessions
        FROM "AnalyticsUserDay" t
       WHERE ${this.wsFilter(q)} AND ${this.range(q, 'day')}
       GROUP BY 1
       ORDER BY 1 ASC
    `);
    return rows.map((r) => ({ bucket: str(r.bucket), users: num(r.users), sessions: num(r.sessions) }));
  }

  /**
   * Retención por cohorte de alta. La cohorte es `firstSeenDay` —escrito al ingerir, nunca deducido
   * escaneando el histórico: la purga de los 90 días convertiría a alguien de hace un año en «nuevo» y la
   * retención saldría alta, que es la peor dirección para equivocarse—.
   *
   * `cohortSize` se cuenta sobre la cohorte ENTERA (todos los que se dieron de alta ese día, activos o
   * no); si se contara solo a los que aparecen en la ventana, el día 0 daría siempre 100 %.
   */
  async retention(q: AnalyticsRange & { cohortDays: number }): Promise<RetentionRow[]> {
    const maxOffset = Math.max(0, Math.floor(Number(q.cohortDays) || 0));
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      WITH cohort AS (
        SELECT t."firstSeenDay" AS d, COUNT(DISTINCT t."userId") AS size
          FROM "AnalyticsUserDay" t
         WHERE ${this.wsFilter(q)} AND ${this.range(q, 'firstSeenDay')}
         GROUP BY 1
      ),
      activity AS (
        SELECT t."firstSeenDay"                     AS d,
               (t."day" - t."firstSeenDay")::int    AS "dayOffset",
               COUNT(DISTINCT t."userId")           AS retained
          FROM "AnalyticsUserDay" t
         WHERE ${this.wsFilter(q)} AND ${this.range(q, 'firstSeenDay')}
           AND t."day" >= t."firstSeenDay"
           AND (t."day" - t."firstSeenDay")::int <= ${maxOffset}
         GROUP BY 1, 2
      )
      SELECT to_char(c.d, 'YYYY-MM-DD') AS cohort, a."dayOffset" AS "dayOffset",
             c.size AS "cohortSize", a.retained AS retained
        FROM cohort c
        JOIN activity a ON a.d = c.d
       ORDER BY cohort ASC, "dayOffset" ASC
    `);
    return rows.map((r) => ({
      cohort: str(r.cohort),
      dayOffset: num(r.dayOffset),
      cohortSize: num(r.cohortSize),
      retained: num(r.retained),
    }));
  }

  // -------------------------------------------------------------------------------------------------
  // Errores, búsqueda y sesiones
  // -------------------------------------------------------------------------------------------------

  /**
   * Errores vistos por la gente (no los del log del servidor: estos son los que alguien SUFRIÓ). El tipo y
   * el código viajan en la dimensión de entidad del rollup, según el convenio de la cabecera.
   *
   * `users` es la suma de los únicos POR HORA, así que sobreestima cuando a la misma persona le revienta
   * lo mismo en horas distintas. Se acepta: aquí el número que decide es `count`, y `users` solo sirve
   * para distinguir «le pasa a todo el mundo» de «le pasa a uno en bucle».
   */
  async errors(q: AnalyticsRange): Promise<ErrorRow[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT t."entityType" AS kind, t."entityId" AS code,
             SUM(t."count") AS count, SUM(t."users") AS users
        FROM "AnalyticsHourlyEvent" t
       WHERE ${this.wsFilter(q)} AND ${this.range(q, 'hour')} AND t."name" = 'error.displayed'
       GROUP BY t."entityType", t."entityId"
       ORDER BY count DESC
       LIMIT ${this.limitOf(q)}
    `);
    return rows.map((r) => ({ kind: str(r.kind), code: str(r.code), count: num(r.count), users: num(r.users) }));
  }

  /**
   * Calidad del buscador, por ámbito. Tres lecturas de rollup, ninguna del crudo:
   *  - búsquedas y ceros salen de `AnalyticsHourlyEvent`, distinguidos por el NOMBRE ('search.performed'
   *    y su gemela 'search.zero'), no por el `entityType`: los dos comparten `entityType = 'search'`
   *    porque los dos se agrupan por el mismo ámbito;
   *  - las selecciones, de `search.selected`;
   *  - los términos en claro, de `AnalyticsSearchTerm`, que solo materializa lo que han tecleado 5+
   *    personas distintas: lo que escribe mucha gente es señal de producto, lo que escribe una sola
   *    persona es de esa persona.
   *
   * `medianTimeToSelectMs` va a `null` y no a un número inventado: una MEDIANA no es aditiva y no se
   * puede reconstruir desde contadores por hora. Para tenerla haría falta que el rollup guardara un
   * histograma de `timeToSelectMs`; mientras no exista esa columna, el dashboard debe pintar «sin dato»
   * en vez de una media disfrazada de mediana.
   */
  async searchQuality(q: AnalyticsRange): Promise<SearchRow[]> {
    const agg = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT t."entityId" AS scope,
             SUM(CASE WHEN t."name" = 'search.performed' THEN t."count" ELSE 0 END) AS searches,
             SUM(CASE WHEN t."name" = 'search.zero'      THEN t."count" ELSE 0 END) AS "zeroResults",
             SUM(CASE WHEN t."name" = 'search.selected'  THEN t."count" ELSE 0 END) AS selections
        FROM "AnalyticsHourlyEvent" t
       WHERE ${this.wsFilter(q)} AND ${this.range(q, 'hour')}
         AND t."name" IN ('search.performed', 'search.zero', 'search.selected')
         AND t."entityType" = 'search'
       GROUP BY t."entityId"
       ORDER BY searches DESC
       LIMIT ${this.limitOf(q)}
    `);

    const terms = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT t."scope" AS scope, t."text" AS text,
             MAX(t."users") AS users, SUM(t."searches") AS searches
        FROM "AnalyticsSearchTerm" t
       WHERE ${this.wsFilter(q)} AND ${this.range(q, 'day')}
       GROUP BY t."scope", t."text"
       ORDER BY users DESC, searches DESC
       LIMIT 200
    `);

    const byScope = new Map<string, SearchRow['topTerms']>();
    for (const r of terms) {
      const scope = str(r.scope);
      const list = byScope.get(scope) ?? [];
      // 10 por ámbito: la cola larga de términos no se lee, y mandarla entera al navegador solo abulta.
      if (list.length < 10) list.push({ text: str(r.text), users: num(r.users), searches: num(r.searches) });
      byScope.set(scope, list);
    }

    return agg.map((r) => {
      const scope = str(r.scope);
      return {
        scope,
        searches: num(r.searches),
        zeroResults: num(r.zeroResults),
        selections: num(r.selections),
        medianTimeToSelectMs: null,
        topTerms: byScope.get(scope) ?? [],
      };
    });
  }

  /**
   * Sesiones de la ventana. Aquí SÍ hay mediana de verdad: `AnalyticsSession` tiene una fila por sesión,
   * no un contador agregado, así que `percentile_cont` trabaja sobre los valores individuales. La media
   * sería engañosa —cuatro pestañas olvidadas abiertas ocho horas se la llevan a donde quieran—.
   *
   * La duración se calcula con `lastSeenAt - startedAt` y no con `activeMs`: la cierra el rollup a partir
   * del primer y último evento, porque las sesiones que más importan (cierre de golpe, caída, móvil en
   * segundo plano) nunca mandan un «he terminado».
   */
  async sessions(q: AnalyticsRange): Promise<SessionsRow> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT COUNT(*)                    AS sessions,
             COUNT(DISTINCT t."userId")  AS users,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (t."lastSeenAt" - t."startedAt")) * 1000
             )                           AS "medianDurationMs",
             COALESCE(SUM(t."eventCount"), 0) AS events
        FROM "AnalyticsSession" t
       WHERE ${this.wsFilter(q)} AND ${this.range(q, 'startedAt')}
    `);

    const r = rows[0] ?? {};
    const sessions = num(r.sessions);
    return {
      sessions,
      users: num(r.users),
      // `null` cuando no hay ni una sesión: un 0 diría «duran cero», que es una afirmación distinta.
      medianDurationMs: r.medianDurationMs === null || r.medianDurationMs === undefined ? null : num(r.medianDurationMs),
      eventsPerSession: sessions === 0 ? 0 : num(r.events) / sessions,
    };
  }

  // -------------------------------------------------------------------------------------------------
  // Inventario de funciones
  // -------------------------------------------------------------------------------------------------

  /**
   * Uso por función CRUZADO CONTRA EL INVENTARIO, y por eso el LEFT JOIN va desde `AnalyticsFeature`: una
   * función que no se dispara nunca no deja ni una fila en el rollup, así que un INNER JOIN —o partir de
   * los eventos— la haría desaparecer del informe justo cuando la respuesta es «no la usa nadie». El cero
   * es el dato.
   *
   * `retiredAt IS NULL` deja fuera lo ya retirado: nadie necesita saber que la función que quitamos el
   * trimestre pasado tiene cero uso.
   *
   * `instrumentedSince` viaja para poder distinguir «no la usa nadie» de «la medimos desde anteayer».
   *
   * CADA `kind` DEL INVENTARIO SE RESUELVE CONTRA LA TABLA DONDE VIVE SU USO. Es el detalle que hace que
   * este panel signifique algo: `AnalyticsFeature` mezcla tres clases de cosa —eventos, pantallas y
   * pestañas— y solo los EVENTOS dejan rastro en `AnalyticsHourlyEvent`. El uso de una pantalla o de una
   * pestaña vive en `AnalyticsHourlyView` (columnas `surface` y `tab`), y buscarlo en la dimensión de
   * entidad del rollup de eventos no falla: devuelve 0. Cruzarlo todo contra una sola tabla dejaba, por
   * tanto, ~25 pantallas y pestañas clavadas a cero para siempre, y como este panel ordena ASCENDENTE
   * esos ceros artificiales ocupaban justo la cabecera — enterrando la única respuesta que se venía a
   * buscar. Un cero tiene que significar «nadie la usa», nunca «la he mirado donde no era».
   *
   * Los dos agregados se calculan APARTE (CTE `usage`) y el inventario los cruza ya reducidos. Además de
   * ser la forma legible, evita de raíz la trampa clásica del LEFT JOIN: si el filtro de tenant y el de
   * ventana estuvieran en el `WHERE` exterior en vez de en el `ON`, descartarían las filas con NULL del
   * lado derecho y el LEFT JOIN se degradaría a INNER — o sea, desaparecerían exactamente las funciones
   * sin uso. Metidos dentro del CTE no hay `ON` que equivocar: lo que se cruza ya viene acotado.
   *
   * `users` de pantallas/pestañas es `sessions` (sesiones distintas por hora, sumadas), no personas:
   * `AnalyticsHourlyView` no guarda usuarios únicos. Es un proxy, y de la misma naturaleza que el `users`
   * de la rama de eventos, que también suma únicos POR HORA y por tanto sobreestima. Aquí la columna que
   * decide es `count`; `users` solo separa «lo toca todo el mundo» de «lo toca uno en bucle».
   */
  async featureUsage(q: AnalyticsRange): Promise<FeatureUsageRow[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      WITH feature_usage AS (
        -- kind='event': un evento del catálogo se cuenta por su NOMBRE en el rollup de eventos.
        SELECT 'event'::text AS kind, t."name" AS key,
               SUM(t."count") AS count, SUM(t."users") AS users
          FROM "AnalyticsHourlyEvent" t
         WHERE ${this.wsFilter(q)} AND ${this.range(q, 'hour')}
         GROUP BY t."name"
        UNION ALL
        -- kind='surface': se colapsa la pestaña, igual que en topSurfaces(), para que una pantalla sin
        -- pestañas y otra con seis sean comparables.
        SELECT 'surface'::text, t."surface",
               SUM(t."views"), SUM(t."sessions")
          FROM "AnalyticsHourlyView" t
         WHERE ${this.wsFilter(q)} AND ${this.range(q, 'hour')}
         GROUP BY t."surface"
        UNION ALL
        -- kind='tab': la pestaña es la clave del inventario y se agrega a través de las pantallas (la
        -- misma pestaña puede existir en varias). Se descarta tab = '', que es «esta vista no tiene
        -- pestañas» y no una pestaña del catálogo.
        SELECT 'tab'::text, t."tab",
               SUM(t."views"), SUM(t."sessions")
          FROM "AnalyticsHourlyView" t
         WHERE ${this.wsFilter(q)} AND ${this.range(q, 'hour')} AND t."tab" <> ''
         GROUP BY t."tab"
      )
      SELECT f."kind" AS kind, f."key" AS key, f."label" AS label,
             to_char(f."instrumentedSince", 'YYYY-MM-DD') AS "instrumentedSince",
             COALESCE(u.count, 0) AS count,
             COALESCE(u.users, 0) AS users
        FROM "AnalyticsFeature" f
        LEFT JOIN feature_usage u ON u.kind = f."kind" AND u.key = f."key"
       WHERE f."retiredAt" IS NULL
       ORDER BY count ASC, f."kind" ASC, f."key" ASC
    `);
    return rows.map((r) => ({
      kind: str(r.kind),
      key: str(r.key),
      label: str(r.label),
      count: num(r.count),
      users: num(r.users),
      instrumentedSince: str(r.instrumentedSince),
    }));
  }

  // -------------------------------------------------------------------------------------------------
  // Embudo
  // -------------------------------------------------------------------------------------------------

  /**
   * ÚNICA EXCEPCIÓN DELIBERADA a la regla de leer solo rollups: el embudo necesita el ORDEN de los pasos
   * dentro de una misma sesión, y un rollup por hora ya ha tirado esa información —agrega, y agregar es
   * precisamente perder el orden—. Un rollup «de embudos» tampoco sirve: habría que fijar de antemano qué
   * secuencias interesan, y la gracia de esta consulta es preguntar por una nueva sin haberla previsto.
   *
   * Se acota fuerte para que el escaneo sea sostenible: ventana temporal, workspace, y solo los eventos
   * cuyo nombre está en los pasos pedidos (el índice `(workspaceId, name, at)` cubre justo eso).
   *
   * El avance se encadena con un CTE por paso: cada uno exige `seq` MAYOR que el del paso anterior en la
   * MISMA sesión —`seq`, no la hora: el reloj del cliente puede ir torcido y dos pestañas se entrelazan,
   * pero el contador de la sesión no— y que no hayan pasado más de `windowMinutes` desde aquel.
   */
  async funnel(q: AnalyticsRange & { steps: EventName[]; windowMinutes: number }): Promise<FunnelRow[]> {
    const steps = q.steps ?? [];
    if (steps.length === 0) return [];
    const windowMinutes = Math.max(1, Math.floor(Number(q.windowMinutes) || 1));

    // Base: un solo barrido de la tabla cruda, ya recortado. Todo lo demás trabaja sobre esto.
    const ctes: Prisma.Sql[] = [
      Prisma.sql`ev AS (
        SELECT t."sessionId", t."userId", t."seq", t."at", t."name"
          FROM "AnalyticsEvent" t
         WHERE ${this.wsFilter(q)} AND ${this.range(q, 'at')}
           AND t."name" IN (${Prisma.join(steps)})
      )`,
      // Paso 0: la PRIMERA vez que cada sesión lo hace. Tomar la primera y no cualquiera evita contar como
      // conversión una repetición posterior del paso inicial.
      Prisma.sql`s0 AS (
        SELECT e."sessionId", e."userId", MIN(e."seq") AS seq, MIN(e."at") AS at
          FROM ev e
         WHERE e."name" = ${steps[0]}
         GROUP BY e."sessionId", e."userId"
      )`,
    ];

    for (let i = 1; i < steps.length; i++) {
      const cur = Prisma.raw(`s${i}`);
      const prev = Prisma.raw(`s${i - 1}`);
      ctes.push(Prisma.sql`${cur} AS (
        SELECT e."sessionId", e."userId", MIN(e."seq") AS seq, MIN(e."at") AS at
          FROM ev e
          JOIN ${prev} p ON p."sessionId" = e."sessionId"
         WHERE e."name" = ${steps[i]}
           AND e."seq" > p.seq
           AND e."at" <= p.at + (${windowMinutes} * interval '1 minute')
         GROUP BY e."sessionId", e."userId"
      )`);
    }

    // Una fila por paso: personas distintas que llegaron hasta él.
    // El índice va por `Prisma.raw` y no enlazado: es un entero nuestro, y un parámetro en la lista de
    // SELECT llega sin tipo que Postgres pueda inferir dentro de un UNION.
    const counts = steps.map((_, i) => {
      const cte = Prisma.raw(`s${i}`);
      const idx = Prisma.raw(String(i));
      return Prisma.sql`SELECT ${idx}::int AS idx, COUNT(DISTINCT "userId") AS users FROM ${cte}`;
    });

    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      WITH ${Prisma.join(ctes, ', ')}
      ${Prisma.join(counts, ' UNION ALL ')}
      ORDER BY idx ASC
    `);

    const usersByIdx = new Map<number, number>();
    for (const r of rows) usersByIdx.set(num(r.idx), num(r.users));

    return steps.map((step, i) => {
      const users = usersByIdx.get(i) ?? 0;
      const prev = i === 0 ? users : (usersByIdx.get(i - 1) ?? 0);
      return {
        step,
        stepIndex: i,
        users,
        // El primer paso es el 100 % por definición. Si el paso anterior es 0 el porcentaje no existe:
        // se devuelve 0 en vez de dividir por cero y mandar un `Infinity` al JSON.
        conversionFromPrev: prev === 0 ? 0 : Math.round((users / prev) * 10000) / 100,
      };
    });
  }
}

/**
 * Postgres devuelve BIGINT en cuanto hay un `COUNT` o un `SUM`, y Prisma lo entrega como `BigInt` (o como
 * `Decimal` cuando el sumando ya era BIGINT). `JSON.stringify` LANZA con `BigInt`, así que sin esta
 * conversión en la frontera la API no responde 500 en el rollup: responde 500 al serializar, que cuesta
 * el triple de encontrar. Se convierte aquí, una vez, y de la clase para dentro todo son `number`.
 */
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v === null || v === undefined) return 0;
  const n = Number(v as never);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}
