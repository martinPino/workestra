import { Inject, Injectable, Logger } from '../http/common';
import {
  parseAnalyticsEvent,
  type AnalyticsBatch,
  type AnalyticsRange,
  type AnalyticsSink,
  type EntityType,
  type EventName,
  type StoredAnalyticsEvent,
} from '@core/contracts';
import { runInSystemMode } from '@core/infra';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';

export const ANALYTICS_SINK = Symbol('ANALYTICS_SINK');

/**
 * Interruptor general de la analítica (M84). Apagado por DEFECTO: recoger datos de navegación de personas
 * es algo que se enciende a propósito, no algo que pasa porque nadie se acordó de apagarlo.
 *
 * Se lee en cada llamada, no una vez al arrancar, para que cambiar la variable en Railway surta efecto en
 * cuanto el servicio reinicia sin depender de ningún caché nuestro.
 *
 * Es la ÚNICA fuente de verdad: la usan la ingesta (para no guardar) y el endpoint de configuración (para
 * que el navegador ni siquiera emita, que es donde está el ahorro de verdad). Si algún día se quiere un
 * interruptor en caliente —una fila en base de datos o los feature flags de Railway—, se cambia aquí y
 * nada más.
 */
export function analyticsEnabled(): boolean {
  return (process.env.ANALYTICS_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/** Tope por workspace y minuto. Generoso para uso real (100 personas a 60 ev/min) y ruinoso para un bucle. */
const MAX_EVENTS_PER_MINUTE = 6_000;
/** El reloj del cliente se acota a ±24 h: un dispositivo con la hora torcida falsearía el DAU de todos. */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

interface RateBucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class AnalyticsService {
  private readonly log = new Logger('analytics');
  private readonly rate = new Map<string, RateBucket>();

  constructor(
    @Inject(ANALYTICS_SINK) private readonly sink: AnalyticsSink,
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
  ) {}

  /**
   * Ingesta de un lote. Devuelve el recuento; el controlador responde 202 sin más.
   *
   * Se valida evento a evento y se DESCARTAN los inválidos en vez de rechazar el lote: si un solo evento
   * mal formado devolviera 400, el cliente reintentaría el mismo lote envenenado para siempre detrás de
   * su cola, y se perderían también los 49 buenos.
   */
  async ingest(batch: AnalyticsBatch, workspaceId: string, userId: string): Promise<{ accepted: number; dropped: number }> {
    // Apagado: se descarta en silencio. El cliente ya no debería estar mandando, pero una pestaña abierta
    // desde antes de apagarlo sí lo haría, y esa no puede seguir escribiendo.
    if (!analyticsEnabled()) return { accepted: 0, dropped: batch.events.length };
    if (!this.allow(workspaceId, batch.events.length)) {
      this.log.warn(`rate limit: workspace ${workspaceId} supera ${MAX_EVENTS_PER_MINUTE} eventos/min`);
      return { accepted: 0, dropped: batch.events.length };
    }

    const now = Date.now();
    const receivedAt = new Date(now).toISOString();
    const rows: StoredAnalyticsEvent[] = [];
    let dropped = 0;

    for (const raw of batch.events) {
      const ev = parseAnalyticsEvent(raw);
      if (!ev) {
        dropped += 1;
        continue;
      }
      if (leaksSecret(ev.props)) {
        // Segunda barrera tras el esquema. Si esto salta, hay una entrada del registro mal puesta:
        // se cuenta aparte precisamente para que se note en vez de pasar desapercibido.
        this.log.error(`evento «${ev.name}» descartado: sus props parecen llevar una credencial`);
        dropped += 1;
        continue;
      }
      rows.push({
        ...ev,
        at: clampClock(ev.at, now),
        // El cliente NO decide de qué workspace ni de quién es un evento: si pudiera, cualquiera
        // escribiría en la analítica de otro. Siempre de la sesión verificada.
        workspaceId,
        userId,
        receivedAt,
      });
    }

    if (rows.length === 0) return { accepted: 0, dropped };
    const res = await this.sink.ingest(rows);
    return { accepted: res.accepted, dropped: dropped + res.dropped };
  }

  /** Cubo por minuto y workspace. En memoria a propósito: es un tope de cordura, no un contador contable. */
  private allow(workspaceId: string, n: number): boolean {
    const now = Date.now();
    const b = this.rate.get(workspaceId);
    if (!b || now >= b.resetAt) {
      this.rate.set(workspaceId, { count: n, resetAt: now + 60_000 });
      // Poda: sin esto el Map crece con cada workspace que haya pasado por aquí alguna vez.
      if (this.rate.size > 5_000) for (const [k, v] of this.rate) if (now >= v.resetAt) this.rate.delete(k);
      return n <= MAX_EVENTS_PER_MINUTE;
    }
    b.count += n;
    return b.count <= MAX_EVENTS_PER_MINUTE;
  }

  // --- Lectura (panel) -----------------------------------------------------------------------------

  /**
   * Ejecuta una consulta del panel. Con `ALL` sale del contexto de tenant para poder cruzar todos los
   * workspaces; esa rama SOLO se alcanza tras pasar el guard de administrador de plataforma, y va aquí
   * concentrada en un único sitio en vez de repartida por cada consulta.
   */
  private read<T>(scope: string | 'ALL', fn: () => Promise<T>): Promise<T> {
    return scope === 'ALL' ? runInSystemMode(fn) : fn();
  }

  overview(q: AnalyticsRange) {
    return this.read(q.workspaceId, async () => {
      const [surfaces, tabs, sessions, active, errors] = await Promise.all([
        this.sink.topSurfaces(q),
        this.sink.tabDwell(q),
        this.sink.sessions(q),
        this.sink.activeUsers({ ...q, grain: 'day' }),
        this.sink.errors(q),
      ]);
      return { surfaces, tabs, sessions, active, errors };
    });
  }

  /** Lo más tocado de un tipo, con el NOMBRE resuelto al leer contra la tabla viva (nunca se guarda). */
  async entities(q: AnalyticsRange & { name: EventName; entityType: EntityType }) {
    const rows = await this.read(q.workspaceId, () => this.sink.topEntities(q));
    // Poner nombre queda FUERA del modo sistema, y en la vista global ni se intenta. Si se hiciera dentro,
    // el nombre de una automatización de otro cliente —«Nóminas de …»— acabaría pintado en el panel: la
    // analítica guarda ids justo para que el nombre se resuelva con el aislamiento del que mira puesto.
    return q.workspaceId === 'ALL' ? rows : this.label(rows, q.entityType);
  }

  features(q: AnalyticsRange) {
    return this.read(q.workspaceId, () => this.sink.featureUsage(q));
  }

  retention(q: AnalyticsRange & { cohortDays: number }) {
    return this.read(q.workspaceId, () => this.sink.retention(q));
  }

  search(q: AnalyticsRange) {
    return this.read(q.workspaceId, () => this.sink.searchQuality(q));
  }

  funnel(q: AnalyticsRange & { steps: EventName[]; windowMinutes: number }) {
    return this.read(q.workspaceId, () => this.sink.funnel(q));
  }

  /**
   * Pone nombre a los ids AL LEER. Los nombres de automatizaciones, trabajadores y conectores son
   * contenido de la persona que los escribió: guardarlos en la tabla de eventos sería meter contenido
   * de usuario en la analítica, así que se guarda el id y se resuelve aquí.
   */
  private async label(rows: Array<{ entityId: string; count: number }>, type: EntityType) {
    // Solo la cabeza de la lista: resolver 200 nombres para pintar 20 sería pagar por lo que no se ve.
    const ids = rows.slice(0, 25).map((r) => r.entityId).filter((id) => id && id !== '__other__');
    if (ids.length === 0 || (type !== 'workflow' && type !== 'agent')) return rows;
    const names = new Map<string, string>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const rec = type === 'workflow' ? await this.p.workflows.get(id) : await this.p.agents.get(id);
          if (rec?.name) names.set(id, rec.name);
        } catch {
          // Sin nombre se muestra el id: preferimos un panel algo más feo a un panel caído.
        }
      }),
    );
    return rows.map((r) => ({ ...r, label: names.get(r.entityId) }));
  }
}

/** Acota la hora del cliente a ±24 h de la recepción. */
function clampClock(at: string, now: number): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return new Date(now).toISOString();
  if (Math.abs(t - now) <= CLOCK_SKEW_MS) return at;
  return new Date(now).toISOString();
}

/**
 * Defensa en profundidad: busca lo que parece una credencial en los valores de las props.
 * El esquema ya impide el texto libre, así que esto no debería saltar NUNCA — y por eso se registra
 * como error: un solo caso significa que hay una entrada del registro mal definida.
 */
const SECRET_SHAPES = [/\baf_[A-Za-z0-9_-]{10,}/, /\bsk-[A-Za-z0-9_-]{10,}/, /\bBearer\s+\S+/i, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./];
function leaksSecret(props: Record<string, unknown>): boolean {
  for (const v of Object.values(props)) {
    if (typeof v !== 'string') continue;
    if (SECRET_SHAPES.some((re) => re.test(v))) return true;
  }
  return false;
}
