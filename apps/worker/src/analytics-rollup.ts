import { EVENT_NAMES, SURFACES, EDITOR_TABS } from '@core/contracts';
import type { createPrismaClient } from '@core/infra';

/**
 * M84 — ROLLUP periódico de la analítica de producto.
 *
 * El dashboard NO lee `AnalyticsEvent`: lee las 7 tablas agregadas. Este job es lo único que las
 * escribe. Corre en el worker (no en la API) porque es trabajo de fondo pesado y con picos: dentro del
 * proceso que atiende peticiones, un rollup lento se traduce en latencia de la interfaz.
 *
 * ---------------------------------------------------------------------------------------------------
 * POR QUÉ «HORA SELLADA» Y NO «recalcula hoy y ayer»
 * ---------------------------------------------------------------------------------------------------
 * La forma fácil de escribir esto es «cada pasada, recalcula hoy y ayer». Con un intervalo de 5 minutos
 * son 288 pasadas al día × 2 días = ~432 veces que se relee un día YA CERRADO, que por definición no
 * puede haber cambiado. Eso es amplificación de lectura pura sobre el MISMO Postgres que sirve el
 * producto: el rollup compite por caché y por E/S con las consultas que ve el usuario, y el día que la
 * tabla crece lo hace en el peor momento (cuando hay tráfico).
 *
 * Aquí una hora CERRADA se agrega EXACTAMENTE UNA VEZ y queda anotada en
 * `AnalyticsRollupWatermark.sealedThrough`. En cada pasada solo se recalcula la hora ABIERTA (la que
 * todavía está recibiendo eventos). El coste por pasada es, por tanto, ~1 hora de eventos, no 2 días.
 *
 * ---------------------------------------------------------------------------------------------------
 * POR QUÉ TODO UPSERT ES ASIGNACIÓN Y NUNCA INCREMENTO
 * ---------------------------------------------------------------------------------------------------
 * Ni un solo `ON CONFLICT` de este fichero hace `col = col + EXCLUDED.col`. Motivo: la ingesta es
 * at-least-once (el cliente reintenta el lote) y Railway puede correr VARIAS réplicas de @app/worker.
 * Con incrementos, un reintento o dos réplicas solapadas inflan los números en silencio — y un número
 * inflado no da error, no rompe nada y no lo detecta nadie: se descubre meses después, cuando ya se han
 * tomado decisiones con él. Un REPLACE de cubo entero es idempotente por construcción: correrlo dos
 * veces da el mismo resultado que correrlo una. Las únicas excepciones son LEAST/GREATEST/COALESCE
 * sobre columnas monótonas (min, max, primer día visto), que también son idempotentes.
 *
 * ---------------------------------------------------------------------------------------------------
 * POR QUÉ EL CERROJO ES `pg_try_advisory_xact_lock` Y NO `pg_advisory_lock`
 * ---------------------------------------------------------------------------------------------------
 * El cerrojo de SESIÓN (`pg_advisory_lock`) se libera cuando la conexión se cierra. Detrás de un pool
 * —y Prisma es un pool— la conexión no se cierra al terminar la función: vuelve al pool, con el cerrojo
 * puesto. Si el proceso muere entre el lock y el unlock, ese cerrojo queda colgado y el rollup se
 * atasca PARA SIEMPRE, sin ruido: la tabla simplemente deja de actualizarse. El cerrojo de TRANSACCIÓN
 * lo suelta Postgres al hacer COMMIT o ROLLBACK, siempre, incluso si el worker se cae en medio.
 * Además usamos la variante `try_`: si otra réplica ya está dentro, esta pasada se salta en vez de
 * encolarse. Encolar pasadas de un job que corre cada 5 minutos solo sirve para amontonarlas.
 */

type PrismaLike = ReturnType<typeof createPrismaClient>;
/** Cliente dentro de una transacción interactiva. Solo necesitamos la parte de SQL en crudo. */
type Tx = Pick<PrismaLike, '$executeRaw' | '$queryRaw'>;

const HOUR_MS = 3_600_000;

/**
 * Lectura de un entero de entorno CON RED DE SEGURIDAD.
 *
 * `Number(process.env.X ?? d)` NO sirve: el `??` solo salta cuando la variable está SIN DEFINIR. Si está
 * definida y vacía —que es exactamente lo que hace Railway cuando se crea la variable y se deja en
 * blanco, o cuando se borra su valor sin borrar la clave— el `??` no dispara, `Number('')` da 0 y
 * `Number('lo que sea')` da NaN. Y ninguno de los dos hace ruido: un NaN en `RETENTION_DAYS` deja el
 * cutoff en «Invalid Date» y la retención deja de borrar PARA SIEMPRE en silencio; un 0 en `ROLLUP_MS`
 * convierte el `setInterval` en un bucle apretado. Se valida el VALOR, no su ausencia: finito y > 0 o el
 * defecto.
 */
const envInt = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** Intervalo entre pasadas. 5 min: suficientemente fresco para un dashboard, barato con hora sellada. */
const ROLLUP_MS = envInt(process.env.ANALYTICS_ROLLUP_MS, 300_000);

/** Días que se conservan los eventos EN CRUDO. Los agregados no caducan (ocupan nada). */
const RETENTION_DAYS = envInt(process.env.ANALYTICS_RETENTION_DAYS, 90);

/**
 * Cuántas horas cerradas se sellan como mucho en una pasada. Sin tope, un arranque en frío (o un worker
 * parado un fin de semana) intentaría sellar cientos de horas en UNA transacción: transacción larguísima,
 * bloat de WAL y un `statement_timeout` que la tira entera y no avanza NADA. Con tope, se pone al día en
 * varias pasadas y cada una consolida su trozo.
 */
const MAX_BACKFILL_HOURS = envInt(process.env.ANALYTICS_MAX_BACKFILL_HOURS, 48);

/**
 * Margen antes de sellar una hora. El servidor acota `at` a ±24 h de la recepción, así que un cliente
 * que estuvo sin red puede entregar eventos con hora de hasta 24 h atrás. Con margen 0 (el defecto) esos
 * rezagados caen en una hora ya sellada y NO se cuentan; a cambio, cada pasada solo relee la hora
 * abierta. Subirlo a 25 recupera el 100 % de los rezagados, pero multiplica por ~26 la lectura de cada
 * pasada. Es una PALANCA consciente, no un olvido: hoy el defecto prioriza el coste.
 */
const SEAL_LAG_HOURS = envInt(process.env.ANALYTICS_SEAL_LAG_HOURS, 0);

/**
 * Tope de cardinalidad de entidad por (workspace, hora, evento, tipo). Sin tope, un workspace con 50 000
 * automatizaciones mete 50 000 filas por hora en `AnalyticsHourlyEvent` y el rollup acaba pesando más
 * que los eventos que resume. Lo que no entra en el top se pliega en `__other__`, que sigue sumando el
 * total correcto: se pierde el desglose de la cola larga, que es justo la parte que nadie mira.
 */
const ENTITY_TOP_N = envInt(process.env.ANALYTICS_ENTITY_TOP_N, 200);

/**
 * Umbral de k-anonimato de las búsquedas. Lo que teclean 5+ personas distintas es una señal de producto;
 * lo que tecleó UNA persona es de esa persona. Por debajo del umbral no se escribe nada, ni agregado.
 */
const SEARCH_MIN_USERS = envInt(process.env.ANALYTICS_SEARCH_MIN_USERS, 5);

/** Trozo del borrado de retención. Ver `runRetention` para por qué nunca es un DELETE sin LIMIT. */
const RETENTION_CHUNK = 10_000;
/** Trozos por pasada. Acota la duración de la transacción; el resto se borra en pasadas siguientes. */
const RETENTION_MAX_CHUNKS = 20;

/** Clave del cerrojo consultivo. Constante y única en el proyecto (M84 + nº de job). */
const ADVISORY_LOCK_KEY = 840_001n;

/** Fila única de la marca de agua. La tabla admite varios buckets; hoy solo hace falta uno. */
const WATERMARK_BUCKET = 'analytics';

// ---------------------------------------------------------------------------------------------------
// Utilidades de tiempo — TODO en UTC, a propósito
// ---------------------------------------------------------------------------------------------------
// Los cubos se calculan en UTC y se pasan como PARÁMETROS; el SQL nunca hace `date_trunc` sobre la hora
// del cubo. Motivo: `date_trunc` sobre `timestamptz` depende del `TimeZone` de la sesión, así que el
// mismo evento podría caer en cubos distintos según qué conexión del pool lo procese — y eso produce
// filas duplicadas que no cuadran con nada.

function floorHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

function addHours(d: Date, n: number): Date {
  return new Date(d.getTime() + n * HOUR_MS);
}

/** Comienzo del día UTC que contiene `d`. */
function floorDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** `YYYY-MM-DD` en UTC, que es lo que espera una columna DATE. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------
// Rollups por hora
// ---------------------------------------------------------------------------------------------------

/**
 * (1) `AnalyticsHourlyView` — pantallas y pestañas.
 *
 * Los dos eventos van en la MISMA consulta con `FILTER` en vez de en dos: un par (pantalla, pestaña)
 * puede tener `view.ended` sin `page.viewed` dentro de la misma hora (se entró a las 10:59 y se salió a
 * las 11:00), y con dos consultas separadas + upsert de asignación, la segunda pisaría a cero las
 * columnas de la primera.
 *
 * `dwellSamples` cuenta solo los `view.ended` que TRAEN `visibleMs`, porque es el denominador de la
 * media. Usar `views` como denominador (el atajo obvio) mete ceros abajo y hunde la media sin que se
 * note; por eso la columna existe por separado en el esquema.
 */
async function rollupHourlyViews(tx: Tx, from: Date, to: Date): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "AnalyticsHourlyView" ("workspaceId", "hour", "surface", "tab", "views", "sessions", "dwellMs", "dwellSamples")
    SELECT
      e."workspaceId",
      ${from}::timestamptz AS "hour",
      e."surface",
      e."tab",
      (COUNT(*) FILTER (WHERE e."name" = 'page.viewed'))::int,
      (COUNT(DISTINCT e."sessionId") FILTER (WHERE e."name" = 'page.viewed'))::int,
      COALESCE((SUM((e."props"->>'visibleMs')::bigint) FILTER (WHERE e."name" = 'view.ended')), 0)::bigint,
      (COUNT(*) FILTER (WHERE e."name" = 'view.ended' AND e."props"->>'visibleMs' IS NOT NULL))::int
    FROM "AnalyticsEvent" e
    WHERE e."at" >= ${from}::timestamptz
      AND e."at" <  ${to}::timestamptz
      AND e."name" IN ('page.viewed', 'view.ended')
    GROUP BY e."workspaceId", e."surface", e."tab"
    ON CONFLICT ("workspaceId", "hour", "surface", "tab") DO UPDATE SET
      "views"        = EXCLUDED."views",
      "sessions"     = EXCLUDED."sessions",
      "dwellMs"      = EXCLUDED."dwellMs",
      "dwellSamples" = EXCLUDED."dwellSamples"
  `;
}

/**
 * (2) `AnalyticsHourlyEvent` — eventos con su entidad, con la cola larga plegada en `__other__`.
 *
 * El pliegue se hace a nivel de EVENTO, no sumando filas ya agregadas. Si se sumaran los `users` de las
 * filas plegadas, la misma persona que tocó 30 entidades de la cola contaría 30 veces y `__other__`
 * saldría con más usuarios únicos que el workspace entero. Por eso hay dos vueltas: primero se ordenan
 * las entidades por volumen, luego se re-agrega desde los eventos con la entidad ya reescrita, y el
 * `COUNT(DISTINCT "userId")` se calcula sobre eventos reales.
 *
 * `entityId = ''` (evento sin entidad) nunca se pliega: es un cubo con significado propio, no cola larga.
 */
async function rollupHourlyEvents(tx: Tx, from: Date, to: Date): Promise<void> {
  // BORRAR ANTES DE REINSERTAR, y no solo confiar en el upsert de asignación.
  //
  // El upsert corrige las filas que VUELVEN a salir del SELECT, pero no puede tocar las que dejaron de
  // salir. Y en una hora ABIERTA dejan de salir constantemente: el pliegue en `__other__` es por top-N,
  // así que una entidad que estaba en el top-200 en la pasada de las 10:05 puede caerse del top en la de
  // las 10:10. Su fila antigua se queda escrita con el conteo viejo y, además, ese mismo tráfico ya está
  // contado dentro del `__other__` recién escrito: el total de la hora sale inflado, y sale inflado en la
  // dirección que nadie revisa. Un DELETE + INSERT del cubo entero es la única forma de que el resultado
  // dependa solo de los eventos y no del historial de pasadas.
  //
  // Va acotado EXACTAMENTE a la hora que se recalcula y dentro de la misma transacción del cerrojo
  // consultivo: fuera de ella, otra réplica (o el propio dashboard) podría leer la hora vacía entre el
  // DELETE y el INSERT. Con MVCC y ambas sentencias en la misma transacción, ese hueco no existe para
  // nadie de fuera.
  //
  // `AnalyticsHourlyView` NO necesita esto: no tiene pliegue por cardinalidad, y su clave
  // (workspace, hora, pantalla, pestaña) solo puede APARECER conforme llegan eventos, nunca desaparecer
  // entre dos pasadas de la misma hora. Ahí el upsert de asignación ya es completo por sí solo.
  await tx.$executeRaw`
    DELETE FROM "AnalyticsHourlyEvent" WHERE "hour" = ${from}::timestamptz
  `;

  await tx.$executeRaw`
    WITH ev AS (
      -- Los errores y las búsquedas no traen entidad propia: su detalle vive en las props (el tipo de
      -- error y su código, o el ámbito de búsqueda). Aquí es donde eso se convierte en una dimensión
      -- consultable; si no se hiciera, los paneles de errores y de búsqueda saldrían a cero en silencio
      -- porque agruparían por una columna vacía.
      SELECT
        e."workspaceId", e."name", e."userId",
        CASE
          WHEN e."name" = 'error.displayed' THEN COALESCE(NULLIF(e."props"->>'kind', ''), 'unknown')
          WHEN e."name" IN ('search.performed', 'search.selected') THEN 'search'
          ELSE e."entityType"
        END AS "entityType",
        CASE
          WHEN e."name" = 'error.displayed' THEN COALESCE(NULLIF(e."props"->>'code', ''), 'unknown')
          WHEN e."name" IN ('search.performed', 'search.selected') THEN COALESCE(e."props"->>'scope', '')
          -- El conector se identifica por PROVEEDOR, no por su fila: el id es un cuid distinto en cada
          -- workspace, así que agrupar por él daría una lista de ids opacos e incomparables entre clientes
          -- —justo lo que la pregunta «¿qué conectores se usan más?» no quiere—.
          WHEN e."name" = 'connector.connected' THEN COALESCE(NULLIF(e."props"->>'provider', ''), e."entityId")
          ELSE e."entityId"
        END AS "entityId"
      FROM "AnalyticsEvent" e
      WHERE e."at" >= ${from}::timestamptz AND e."at" < ${to}::timestamptz
      UNION ALL
      -- Fila GEMELA de las búsquedas SIN resultados. Es la señal más útil del buscador —qué busca la
      -- gente y no encuentra— y no cabía en el rollup sin una columna propia, así que se modela como
      -- otra dimensión. Comparación textual con '0' a propósito: castear a int reventaría si algún día
      -- llega un valor raro, y este SQL corre cada 5 minutos.
      --
      -- La gemela cambia el NOMBRE a 'search.zero', no solo el entityType. Antes conservaba
      -- name = 'search.performed', y eso convertía a la gemela en un DUPLICADO para cualquier consumidor
      -- que agregue por name sin filtrar además por entityType — el caso real es featureUsage(), que
      -- cruza el inventario contra name y contaba dos veces cada búsqueda sin resultados. Al cambiar el
      -- nombre, la gemela deja de sumar en el evento del catálogo y pasa a ser una dimensión propia:
      -- 'search.zero' NO está en EVENT_NAMES, así que tampoco aparece en el inventario de funciones.
      -- OJO: searchQuality() en @core/infra lee esta fila por su nombre; los dos lados tienen que decir
      -- exactamente lo mismo o el panel de ceros sale a 0 sin error.
      SELECT
        e."workspaceId", 'search.zero' AS "name", e."userId", 'search' AS "entityType",
        COALESCE(e."props"->>'scope', '') AS "entityId"
      FROM "AnalyticsEvent" e
      WHERE e."at" >= ${from}::timestamptz AND e."at" < ${to}::timestamptz
        AND e."name" = 'search.performed'
        AND e."props"->>'resultCount' = '0'
    ),
    counts AS (
      SELECT ev."workspaceId", ev."name", ev."entityType", ev."entityId", COUNT(*) AS cnt
      FROM ev
      GROUP BY ev."workspaceId", ev."name", ev."entityType", ev."entityId"
    ),
    ranked AS (
      SELECT
        counts.*,
        ROW_NUMBER() OVER (
          PARTITION BY counts."workspaceId", counts."name", counts."entityType"
          ORDER BY counts.cnt DESC, counts."entityId" ASC
        ) AS rn
      FROM counts
    ),
    mapped AS (
      SELECT
        ev."workspaceId", ev."name", ev."entityType", ev."userId",
        CASE WHEN ev."entityId" = '' OR r.rn <= ${ENTITY_TOP_N}::int THEN ev."entityId" ELSE '__other__' END AS eid
      FROM ev
      JOIN ranked r
        ON  r."workspaceId" = ev."workspaceId"
        AND r."name"        = ev."name"
        AND r."entityType"  = ev."entityType"
        AND r."entityId"    = ev."entityId"
    )
    INSERT INTO "AnalyticsHourlyEvent" ("workspaceId", "hour", "name", "entityType", "entityId", "count", "users")
    SELECT
      mapped."workspaceId",
      ${from}::timestamptz,
      mapped."name",
      mapped."entityType",
      mapped.eid,
      COUNT(*)::int,
      COUNT(DISTINCT mapped."userId")::int
    FROM mapped
    GROUP BY mapped."workspaceId", mapped."name", mapped."entityType", mapped.eid
    ON CONFLICT ("workspaceId", "hour", "name", "entityType", "entityId") DO UPDATE SET
      "count" = EXCLUDED."count",
      "users" = EXCLUDED."users"
  `;
}

/**
 * (4) `AnalyticsSession` — una fila por sesión, cerrada desde los eventos.
 *
 * Las sesiones que más importan (cerrar el portátil de golpe, quedarse sin batería, el móvil en segundo
 * plano) nunca mandan un «he terminado», así que el cierre se DEDUCE del min/max de sus eventos.
 *
 * La ventana de reconstrucción es `[hora − lookback, fin de hora)` y no «todos los eventos de esa
 * sesión»: `AnalyticsEvent` NO tiene índice por `sessionId` (sus índices empiezan por `at` o por
 * `workspaceId`), así que un JOIN por sesión contra la tabla entera es un seq scan de todo el histórico
 * en cada pasada. Con ventana, se usa el índice de `at`.
 *
 * Consecuencia: una sesión más larga que la ventana se recalcularía recortada. Por eso el conflicto usa
 * LEAST/GREATEST/COALESCE en vez de asignación pura — son idempotentes igual (repetir la pasada da lo
 * mismo) pero nunca ENCOGEN una sesión ya conocida ni borran un dato que una pasada anterior sí vio.
 *
 * `device`/`browser`/`os`/`timezone` salen de `MAX(props->>…)`, que ignora los NULL: si ningún evento
 * los trae, la columna queda NULL. HOY, de hecho, quedan siempre NULL: el registro de props de
 * `@core/contracts` es `.strict()` y ningún evento declara esos campos — llegan por `SessionInfo`, que
 * es un canal aparte que todavía no se persiste. Se deja escrito así para que el día que ese canal
 * exista no haya que tocar esta consulta. `country` no se toca: requiere una CDN que inyecte el país.
 */
async function rollupSessions(tx: Tx, from: Date, to: Date, lookbackHours: number): Promise<void> {
  const windowStart = addHours(from, -lookbackHours);
  await tx.$executeRaw`
    WITH touched AS (
      SELECT DISTINCT e."sessionId"
      FROM "AnalyticsEvent" e
      WHERE e."at" >= ${from}::timestamptz AND e."at" < ${to}::timestamptz
    ),
    ev AS (
      SELECT e.*
      FROM "AnalyticsEvent" e
      JOIN touched t ON t."sessionId" = e."sessionId"
      WHERE e."at" >= ${windowStart}::timestamptz AND e."at" < ${to}::timestamptz
    )
    INSERT INTO "AnalyticsSession" AS s (
      "id", "workspaceId", "userId", "startedAt", "lastSeenAt", "activeMs", "eventCount",
      "device", "browser", "os", "timezone", "entrySurface", "exitSurface"
    )
    SELECT
      ev."sessionId",
      MIN(ev."workspaceId"),
      MIN(ev."userId"),
      MIN(ev."at"),
      MAX(ev."at"),
      COALESCE(SUM(CASE WHEN ev."name" = 'view.ended' THEN (ev."props"->>'visibleMs')::bigint ELSE 0 END), 0)::bigint,
      COUNT(*)::int,
      MAX(ev."props"->>'device'),
      MAX(ev."props"->>'browser'),
      MAX(ev."props"->>'os'),
      MAX(ev."props"->>'timezone'),
      (array_agg(ev."surface" ORDER BY ev."seq" ASC,  ev."at" ASC))[1],
      (array_agg(ev."surface" ORDER BY ev."seq" DESC, ev."at" DESC))[1]
    FROM ev
    GROUP BY ev."sessionId"
    ON CONFLICT ("id") DO UPDATE SET
      "startedAt"    = LEAST(s."startedAt", EXCLUDED."startedAt"),
      "lastSeenAt"   = GREATEST(s."lastSeenAt", EXCLUDED."lastSeenAt"),
      "activeMs"     = GREATEST(s."activeMs", EXCLUDED."activeMs"),
      "eventCount"   = GREATEST(s."eventCount", EXCLUDED."eventCount"),
      "device"       = COALESCE(EXCLUDED."device", s."device"),
      "browser"      = COALESCE(EXCLUDED."browser", s."browser"),
      "os"           = COALESCE(EXCLUDED."os", s."os"),
      "timezone"     = COALESCE(EXCLUDED."timezone", s."timezone"),
      "entrySurface" = CASE WHEN EXCLUDED."startedAt"  <= s."startedAt"  THEN EXCLUDED."entrySurface" ELSE s."entrySurface" END,
      "exitSurface"  = CASE WHEN EXCLUDED."lastSeenAt" >= s."lastSeenAt" THEN EXCLUDED."exitSurface"  ELSE s."exitSurface"  END
  `;
}

// ---------------------------------------------------------------------------------------------------
// Rollups por día
// ---------------------------------------------------------------------------------------------------

/**
 * (3) `AnalyticsUserDay` — el conjunto persona×día.
 *
 * Se recalcula el DÍA entero, no la hora, y no hay atajo: los ÚNICOS no son aditivos. Sumar las 24 horas
 * de «usuarios distintos por hora» da un número mayor que el real (quien entra a las 9 y a las 17 cuenta
 * dos veces), así que DAU/WAU/MAU y la retención salen de aquí y solo de aquí. El coste está acotado a
 * los días TOCADOS por las horas de esta pasada — normalmente uno, dos en el cambio de día —, no a una
 * ventana fija «hoy y ayer».
 *
 * `firstSeenDay` es la columna delicada de toda la analítica. Si se sobrescribe hacia ARRIBA, un usuario
 * de hace un año se reclasifica como nuevo y la cohorte de retención mejora sola, para siempre y sin
 * error visible. Por eso el conflicto hace LEAST(existente, nuevo): nunca sube.
 */
async function rollupUserDay(tx: Tx, day: Date): Promise<void> {
  const from = day;
  const to = new Date(day.getTime() + 24 * HOUR_MS);
  const key = dayKey(day);

  await tx.$executeRaw`
    INSERT INTO "AnalyticsUserDay" AS ud ("workspaceId", "day", "userId", "firstSeenDay", "sessions", "activeMs")
    SELECT
      e."workspaceId",
      ${key}::date,
      e."userId",
      ${key}::date,
      COUNT(DISTINCT e."sessionId")::int,
      COALESCE(SUM(CASE WHEN e."name" = 'view.ended' THEN (e."props"->>'visibleMs')::bigint ELSE 0 END), 0)::bigint
    FROM "AnalyticsEvent" e
    WHERE e."at" >= ${from}::timestamptz AND e."at" < ${to}::timestamptz
    GROUP BY e."workspaceId", e."userId"
    ON CONFLICT ("workspaceId", "day", "userId") DO UPDATE SET
      "sessions"     = EXCLUDED."sessions",
      "activeMs"     = EXCLUDED."activeMs",
      "firstSeenDay" = LEAST(ud."firstSeenDay", EXCLUDED."firstSeenDay")
  `;

  // El LEAST del conflicto solo protege las filas que YA existían. La fila que se inserta hoy por primera
  // vez nace con `firstSeenDay` = hoy aunque esa persona lleve un año entrando: en un INSERT no hay
  // conflicto contra el que aplicar LEAST, porque la fila antigua es de OTRO día (otra clave primaria).
  // Sin este repaso, cada usuario recurrente aparecería como «nuevo» el día que se rellena — que es
  // exactamente el error que infla la retención. Se limita al día tocado y la tabla es persona×día
  // (pequeña por definición: no crece con el volumen de eventos, solo con la plantilla).
  await tx.$executeRaw`
    UPDATE "AnalyticsUserDay" t
    SET "firstSeenDay" = m."minDay"
    FROM (
      SELECT ud."workspaceId", ud."userId", MIN(ud."firstSeenDay") AS "minDay"
      FROM "AnalyticsUserDay" ud
      GROUP BY ud."workspaceId", ud."userId"
    ) m
    WHERE t."workspaceId" = m."workspaceId"
      AND t."userId"      = m."userId"
      AND t."day"         = ${key}::date
      AND t."firstSeenDay" > m."minDay"
  `;
}

/**
 * (5) `AnalyticsSearchTerm` — búsquedas agregadas, con k-anonimato.
 *
 * PRIVACIDAD, y es la parte importante de esta función: solo se materializa un término cuando lo han
 * tecleado `SEARCH_MIN_USERS` personas DISTINTAS del mismo workspace y día. Por debajo del umbral no se
 * escribe nada — ni una fila con contadores —, porque una búsqueda que hizo una sola persona no es una
 * señal de producto, es información de esa persona.
 *
 * SOBRE LA COLUMNA `text`: los eventos en crudo NO contienen el texto de la búsqueda. Es deliberado, no
 * un olvido: `search.performed` en `@core/contracts` solo admite `queryHash` (32 hex), y el buscador es
 * texto libre donde la gente escribe nombres de clientes, correos y direcciones. NO EXISTE ninguna
 * fuente en claro que este job pueda leer, y no se debe inventar una: reconstruir el texto desde el hash
 * exigiría un diccionario de candidatos, que es precisamente la fuga que el hash evita.
 *
 * Por eso `text` se rellena con el PREFIJO del hash. Es un identificador legible para agrupar en el
 * dashboard, no la búsqueda. Materializar el texto de verdad requiere un canal aparte con
 * consentimiento explícito (que el cliente mande el texto SOLO para búsquedas ya conocidas como
 * frecuentes, o un opt-in por workspace). Ese canal no existe; cuando exista, se cambia aquí.
 *
 * `zeroResults` (búsquedas con 0 resultados) se calcula bien desde `props->>'resultCount'`, pero la
 * tabla `AnalyticsSearchTerm` no tiene columna donde guardarlo — haría falta una migración. No se
 * inventa un sitio donde meterlo.
 *
 * `scope` no forma parte de la clave primaria, así que un mismo hash buscado en dos ámbitos colapsa en
 * una fila; se toma el MIN para que el resultado sea determinista entre pasadas (si no, dos pasadas
 * podrían escribir ámbitos distintos y la fila «parpadearía»).
 */
async function rollupSearchTerms(tx: Tx, day: Date): Promise<void> {
  const from = day;
  const to = new Date(day.getTime() + 24 * HOUR_MS);
  const key = dayKey(day);

  await tx.$executeRaw`
    INSERT INTO "AnalyticsSearchTerm" ("workspaceId", "day", "queryHash", "scope", "text", "users", "searches")
    SELECT
      e."workspaceId",
      ${key}::date,
      e."props"->>'queryHash',
      MIN(e."props"->>'scope'),
      'hash:' || left(e."props"->>'queryHash', 8),
      COUNT(DISTINCT e."userId")::int,
      COUNT(*)::int
    FROM "AnalyticsEvent" e
    WHERE e."at" >= ${from}::timestamptz
      AND e."at" <  ${to}::timestamptz
      AND e."name" = 'search.performed'
      AND e."props"->>'queryHash' IS NOT NULL
    GROUP BY e."workspaceId", e."props"->>'queryHash'
    HAVING COUNT(DISTINCT e."userId") >= ${SEARCH_MIN_USERS}::int
    ON CONFLICT ("workspaceId", "day", "queryHash") DO UPDATE SET
      "scope"    = EXCLUDED."scope",
      "text"     = EXCLUDED."text",
      "users"    = EXCLUDED."users",
      "searches" = EXCLUDED."searches"
  `;
}

// ---------------------------------------------------------------------------------------------------
// (7) Retención
// ---------------------------------------------------------------------------------------------------

/**
 * Borra los eventos en crudo más viejos que la ventana de retención, A TROZOS.
 *
 * Nunca un `DELETE ... WHERE at < X` sin límite: el primer día que la tabla tenga decenas de millones de
 * filas, ese DELETE coge millones de locks de fila, hincha el WAL, bloquea el autovacuum y —si hay
 * `statement_timeout`, que en Railway lo hay— se cae al final y hace ROLLBACK de TODO. Es decir: tarda
 * una eternidad y no borra nada. Con trozos, cada trozo confirma su parte y el trabajo avanza siempre.
 *
 * `ctid IN (SELECT ctid ... LIMIT n)` en vez de un DELETE con LIMIT (que Postgres no soporta): el
 * subselect elige n filas físicas concretas y el DELETE las borra por dirección física, sin volver a
 * evaluar el predicado.
 *
 * El tope de trozos por pasada acota cuánto dura la transacción; lo que quede se borra en la siguiente.
 */
async function runRetention(tx: Tx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * HOUR_MS);
  let deleted = 0;
  for (let i = 0; i < RETENTION_MAX_CHUNKS; i++) {
    const n = await tx.$executeRaw`
      DELETE FROM "AnalyticsEvent"
      WHERE ctid IN (
        SELECT e.ctid FROM "AnalyticsEvent" e
        WHERE e."at" < ${cutoff}::timestamptz
        LIMIT ${RETENTION_CHUNK}::int
      )
    `;
    deleted += n;
    if (n === 0) break; // ya no queda nada viejo: se sale, no se gastan los 20 trozos
  }
  return deleted;
}

// ---------------------------------------------------------------------------------------------------
// (8) Inventario de funciones
// ---------------------------------------------------------------------------------------------------

/**
 * Vuelca a `AnalyticsFeature` lo que el CÓDIGO sabe que existe.
 *
 * Sin esto, la pregunta «¿qué función no usa nadie?» no se puede responder: una función que no se
 * dispara nunca no deja NI UNA fila en los rollups, así que es invisible para cualquier consulta que
 * parta de los eventos. El inventario es el lado izquierdo del LEFT JOIN.
 *
 * `instrumentedSince` se escribe en el INSERT y NO se toca en el UPDATE. Es lo único que distingue «no
 * la usa nadie» de «la empezamos a medir el martes»: si se sobrescribiera con la fecha de hoy en cada
 * pasada, todas las funciones parecerían recién instrumentadas para siempre y el dato no diría nada.
 *
 * Fuentes: los vocabularios cerrados de `@core/contracts` (eventos, pantallas, pestañas del editor).
 * NO se inventarían plantillas ni conectores: viven en `@core/sdk-plugins` y en el catálogo del front
 * (`apps/web/src/marketplace`), y sacarlos desde el worker obligaría a arrastrar aquí el registro de
 * plugins solo para esto. Es un inventario que falta, no uno resuelto a medias.
 */
async function syncFeatureInventory(tx: Tx, now: Date): Promise<void> {
  const kinds: string[] = [];
  const keys: string[] = [];
  const labels: string[] = [];

  const push = (kind: string, key: string, label: string): void => {
    kinds.push(kind);
    keys.push(key);
    labels.push(label);
  };

  // Solo se inventarían los eventos que ALGUIEN emite. Sembrar los demás llenaría el panel de «lo que
  // nadie usa» con funciones que en realidad nadie MIDE: un cero dejaría de significar desuso y pasaría a
  // significar «no lo hemos instrumentado», que es la confusión exacta que el inventario existe para
  // deshacer. Cuando se instrumente alguno, se quita de aquí y aparece con su `instrumentedSince` real.
  const SIN_INSTRUMENTAR = new Set<string>(['search.selected', 'modal.opened', 'modal.closed', 'custom']);
  for (const name of EVENT_NAMES) if (!SIN_INSTRUMENTAR.has(name)) push('event', name, name);
  for (const surface of SURFACES) push('surface', surface, surface);
  for (const tab of EDITOR_TABS) push('tab', tab, tab);

  await tx.$executeRaw`
    INSERT INTO "AnalyticsFeature" ("kind", "key", "label", "instrumentedSince")
    SELECT t.kind, t.key, t.label, ${dayKey(now)}::date
    FROM unnest(${kinds}::text[], ${keys}::text[], ${labels}::text[]) AS t(kind, key, label)
    ON CONFLICT ("kind", "key") DO UPDATE SET "label" = EXCLUDED."label"
  `;
}

// ---------------------------------------------------------------------------------------------------
// (6) Marca de agua y métricas de mudanza
// ---------------------------------------------------------------------------------------------------

interface RollupMetrics {
  analyticsRows: number;
  analyticsBytes: number;
  eventsLast24h: number;
}

/**
 * Las tres cifras que deciden CUÁNDO hay que sacar la analítica de Postgres. Un umbral que nadie mide es
 * un comentario: si estos números no se guardan en cada pasada, la conversación «¿ya toca ClickHouse?»
 * se tiene con intuiciones.
 *
 * `analyticsRows` es la ESTIMACIÓN de `pg_class.reltuples`, no un `COUNT(*)`. Un COUNT exacto es un
 * escaneo completo de la tabla más caliente del sistema, y hacerlo cada 5 minutos para pintar un número
 * de capacidad sería el mismo pecado que este job existe para evitar. Para decidir una mudanza, un ±5 %
 * sobra. `reltuples` vale −1 si la tabla nunca pasó por ANALYZE: en ese caso se reporta 0.
 */
async function collectMetrics(tx: Tx): Promise<RollupMetrics> {
  const rows = await tx.$queryRaw<Array<{ rows: bigint; bytes: bigint; last24h: bigint }>>`
    SELECT
      GREATEST(COALESCE((SELECT c.reltuples FROM pg_class c WHERE c.oid = '"AnalyticsEvent"'::regclass), 0), 0)::bigint AS rows,
      pg_total_relation_size('"AnalyticsEvent"'::regclass)::bigint AS bytes,
      (SELECT COUNT(*) FROM "AnalyticsEvent" e WHERE e."at" >= now() - interval '24 hours')::bigint AS last24h
  `;
  const r = rows[0];
  return {
    analyticsRows: r ? Number(r.rows) : 0,
    analyticsBytes: r ? Number(r.bytes) : 0,
    eventsLast24h: r ? Number(r.last24h) : 0,
  };
}

// ---------------------------------------------------------------------------------------------------
// La pasada
// ---------------------------------------------------------------------------------------------------

export interface RollupPassResult {
  /** `false` cuando otra réplica tenía el cerrojo, o cuando no hay Postgres. */
  ran: boolean;
  sealedHours: number;
  openHours: number;
  days: number;
  deletedEvents: number;
  metrics?: RollupMetrics;
}

/**
 * Una pasada completa. Exportada aparte del intervalo para poder invocarla a mano (o desde un test)
 * sin montar un temporizador.
 */
export async function runAnalyticsRollup(prisma: PrismaLike): Promise<RollupPassResult> {
  const empty: RollupPassResult = { ran: false, sealedHours: 0, openHours: 0, days: 0, deletedEvents: 0 };

  // Sin Postgres no hay nada que agregar: en desarrollo el worker arranca con PERSISTENCE=memory y este
  // job debe callarse, no fallar cada 5 minutos con un error de conexión que tape los logs de verdad.
  if (process.env.PERSISTENCE !== 'postgres') return empty;

  return prisma.$transaction(
    async (tx) => {
      // Cerrojo de TRANSACCIÓN (ver la cabecera del fichero). `try_` para saltar la pasada en vez de
      // encolarla si otra réplica está dentro.
      const lock = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}::bigint) AS locked
      `;
      if (!lock[0]?.locked) return empty;

      // El reloj lo pone POSTGRES, no el worker: con varias réplicas, dos relojes ligeramente distintos
      // sellarían horas distintas y la marca de agua podría retroceder.
      const clock = await tx.$queryRaw<Array<{ now: Date; sealed: Date | null; first: Date | null }>>`
        SELECT
          now() AS now,
          (SELECT w."sealedThrough" FROM "AnalyticsRollupWatermark" w WHERE w."bucket" = ${WATERMARK_BUCKET}) AS sealed,
          (SELECT MIN(e."at") FROM "AnalyticsEvent" e) AS first
      `;
      const now = clock[0]?.now ?? new Date();
      const sealedThrough = clock[0]?.sealed ?? null;
      const firstEventAt = clock[0]?.first ?? null;

      const currentHour = floorHour(now);
      // Frontera de sellado: por debajo se sella, de aquí en adelante se recalcula en cada pasada.
      const sealCutoff = addHours(currentHour, -Math.max(0, SEAL_LAG_HOURS));

      // Horas a SELLAR: desde la siguiente a la última sellada (o desde el primer evento, en arranque en
      // frío) hasta la frontera. Nunca por debajo de la ventana de retención: agregar horas cuyos eventos
      // el propio job está borrando es trabajo que se tira.
      const retentionFloor = floorHour(new Date(now.getTime() - RETENTION_DAYS * 24 * HOUR_MS));
      let cursor: Date | null = null;
      if (sealedThrough) cursor = addHours(floorHour(sealedThrough), 1);
      else if (firstEventAt) cursor = floorHour(firstEventAt);
      if (cursor && cursor < retentionFloor) cursor = retentionFloor;

      const sealed: Date[] = [];
      if (cursor) {
        for (let h = cursor; h < sealCutoff && sealed.length < MAX_BACKFILL_HOURS; h = addHours(h, 1)) {
          sealed.push(h);
        }
      }

      // Horas ABIERTAS: la actual siempre, más el margen de rezagados si está configurado. Se recalculan
      // en cada pasada y NO avanzan la marca de agua.
      const open: Date[] = [];
      for (let h = sealCutoff; h <= currentHour; h = addHours(h, 1)) open.push(h);

      const hours = [...sealed, ...open];
      for (const hour of hours) {
        const to = addHours(hour, 1);
        await rollupHourlyViews(tx, hour, to);
        await rollupHourlyEvents(tx, hour, to);
        // Ventana de reconstrucción de sesión: 12 h cubre de sobra una sesión de navegador real.
        await rollupSessions(tx, hour, to, 12);
      }

      // Los días se recalculan UNA vez por pasada aunque la pasada toque 24 horas del mismo día: el
      // rollup de día es el caro (escanea el día entero) y repetirlo por hora sería multiplicarlo por 24.
      const days = new Map<string, Date>();
      for (const hour of hours) {
        const d = floorDay(hour);
        days.set(dayKey(d), d);
      }
      for (const day of days.values()) {
        await rollupUserDay(tx, day);
        await rollupSearchTerms(tx, day);
      }

      await syncFeatureInventory(tx, now);
      const deletedEvents = await runRetention(tx, now);
      const metrics = await collectMetrics(tx);

      // La marca de agua solo AVANZA con horas selladas. Si esta pasada no selló ninguna (lo normal:
      // dentro de la misma hora), se conserva la anterior; y si nunca hubo ninguna y tampoco hay eventos,
      // se ancla justo antes de la frontera para no volver a barrer el vacío en cada pasada.
      const nextSealed = sealed.length > 0 ? sealed[sealed.length - 1]! : (sealedThrough ?? addHours(sealCutoff, -1));

      await tx.$executeRaw`
        INSERT INTO "AnalyticsRollupWatermark" ("bucket", "sealedThrough", "lastRunAt", "metrics")
        VALUES (${WATERMARK_BUCKET}, ${nextSealed}::timestamptz, ${now}::timestamptz, ${JSON.stringify(metrics)}::jsonb)
        ON CONFLICT ("bucket") DO UPDATE SET
          "sealedThrough" = EXCLUDED."sealedThrough",
          "lastRunAt"     = EXCLUDED."lastRunAt",
          "metrics"       = EXCLUDED."metrics"
      `;

      return {
        ran: true,
        sealedHours: sealed.length,
        openHours: open.length,
        days: days.size,
        deletedEvents,
        metrics,
      };
    },
    // El timeout por defecto de una transacción interactiva de Prisma son 5 s, que un arranque en frío se
    // come sin despeinarse; y `maxWait` evita que la pasada se quede esperando una conexión del pool que
    // hace falta para servir ejecuciones (el trabajo de verdad del worker manda sobre la analítica).
    { timeout: 120_000, maxWait: 10_000 },
  );
}

/**
 * Arranca el bucle. Copia el patrón de los otros sondeos de este worker (`pollSentryBindings`, el sondeo
 * de Drive): un flag para no solapar corridas y un try/catch que se lo traga TODO.
 *
 * Lo del try/catch no es cosmético: una excepción que se escapa del callback de un `setInterval` es una
 * `unhandledRejection`, y en Node 18+ eso TUMBA el proceso. Un rollup que falla (un deadlock, un
 * timeout, un evento con props raras) no puede llevarse por delante al worker que ejecuta los workflows
 * de los clientes. Falla la pasada, se registra, y dentro de 5 minutos se reintenta — y como todo es
 * idempotente, reintentar no cuesta nada.
 */
export function startAnalyticsRollup(prisma: PrismaLike): void {
  if (process.env.PERSISTENCE !== 'postgres') {
    console.log('[analytics-rollup] PERSISTENCE != postgres: rollup desactivado.');
    return;
  }

  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return; // no solapar: una pasada lenta no debe amontonarse con la siguiente
    running = true;
    try {
      const r = await runAnalyticsRollup(prisma);
      if (!r.ran) return; // otra réplica lo tenía; sin ruido en los logs
      console.log(
        `[analytics-rollup] horas selladas=${r.sealedHours} abiertas=${r.openHours} días=${r.days} ` +
          `purgados=${r.deletedEvents} filas~=${r.metrics?.analyticsRows ?? 0} bytes=${r.metrics?.analyticsBytes ?? 0} 24h=${r.metrics?.eventsLast24h ?? 0}`,
      );
    } catch (e) {
      console.error('[analytics-rollup]', e instanceof Error ? e.message : String(e));
    } finally {
      running = false;
    }
  };

  setInterval(() => void pass(), ROLLUP_MS);
  void pass(); // primera pasada al arrancar: fija la marca de agua sin esperar 5 minutos
}
