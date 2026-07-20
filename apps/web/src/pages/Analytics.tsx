import { useState, type ReactNode } from 'react';
import { AlertTriangle, Activity, Clock, Filter, Inbox, Layers, Search, Sparkles, Users } from 'lucide-react';
import type { EventName } from '@core/contracts';
import { Page } from '../app/AppShell';
import { Card, PageHeader, Tabs, EmptyState, Skeleton, Badge, Stat } from '../ui';
import {
  useInsightsEntities,
  useInsightsFeatures,
  useInsightsFunnel,
  useInsightsMe,
  useInsightsOverview,
  useInsightsRetention,
  useInsightsSearch,
} from '../lib/hooks';
import type { InsightsQuery } from '../lib/api';
import { cn } from '../lib/cn';
import { useT } from '../i18n';

/* ---------------------------------------------------------------------------------------------- */
/* Avisos que acompañan a los datos.                                                                */
/*                                                                                                  */
/* No son adorno: cada cifra de esta página se puede leer mal de una manera concreta, y el aviso     */
/* vive pegado a la cifra porque una nota metodológica en otro sitio no la lee nadie.                */
/* ---------------------------------------------------------------------------------------------- */

/** La permanencia se pierde un poco SIEMPRE, y siempre hacia abajo. Decirlo evita presentarla como exacta. */
const DWELL_NOTE =
  'La permanencia se mide con un aviso que el navegador manda al salir de la pantalla, y una parte pequeña se pierde siempre (cierres de golpe, pestañas en segundo plano, bloqueadores). La cifra queda algo POR DEBAJO de la real: sirve para comparar pantallas entre sí, no como medida exacta.';

/** El hueco de la mediana. Se explica en vez de taparlo: un hueco explicado informa; una media disfrazada, no. */
const MEDIAN_NOTE =
  'El tiempo hasta el clic sale «—» porque hoy no existe: una mediana no se puede reconstruir desde contadores por hora. Aparecerá cuando el rollup guarde el histograma.';

/** Qué mide de verdad el panel de conexiones. Sin esto, cualquiera lo lee como «uso del conector». */
const CONNECTOR_NOTE =
  'Cuenta conexiones abiertas y conectadas DESDE LA INTERFAZ, no invocaciones en ejecución: los conectores se ejecutan en el servidor y eso no pasa nunca por el navegador.';

const NO_DATA = 'Aún no hay datos: las métricas aparecen tras el primer rollup.';

const RANGES = [7, 30, 90] as const;

/** Recorrido por defecto: crear algo → lanzarlo → que salga bien. Es donde se ve dónde abandona la gente. */
const FUNNEL_STEPS: EventName[] = ['workflow.created', 'workflow.run.started', 'workflow.run.succeeded'];
const FUNNEL_WINDOW_MINUTES = 60;

/* ---------------------------------------------------------------------------------------------- */
/* Etiquetas legibles                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/** Las pantallas llegan como PATRÓN de ruta (nunca la URL real). Aquí se les pone nombre humano. */
const SURFACE_LABEL: Record<string, string> = {
  '/': 'Inicio',
  '/workflows': 'Automatizaciones',
  '/workflows/:id': 'Editor de automatización',
  '/agents': 'Trabajadores',
  '/executions': 'Historial',
  '/executions/:id': 'Detalle de ejecución',
  '/marketplace': 'Marketplace',
  '/marketplace/:id': 'Detalle de plantilla',
  '/integrations': 'Conexiones',
  '/team': 'Equipo',
  '/settings': 'Ajustes',
  '/analytics': 'Analítica',
  '/login': 'Entrar',
  '/register': 'Crear cuenta',
  '/invite/:token': 'Invitación',
  unknown: 'Pantalla desconocida',
};

const TAB_LABEL: Record<string, string> = {
  overview: 'Resumen',
  canvas: 'Lienzo',
  executions: 'Ejecuciones',
  logs: 'Registros',
  replay: 'Repetición',
  variables: 'Variables',
  knowledge: 'Conocimiento',
  members: 'Miembros',
  settings: 'Ajustes',
  'exec:all': 'Historial · Todas',
  'exec:ok': 'Historial · Correctas',
  'exec:err': 'Historial · Con incidencias',
  'exec:reviews': 'Historial · Revisiones',
};

const EVENT_LABEL: Record<string, string> = {
  'workflow.created': 'Crea una automatización',
  'workflow.run.started': 'La pone en marcha',
  'workflow.run.succeeded': 'Termina sin errores',
};

const ERROR_KIND_LABEL: Record<string, string> = {
  frontend: 'Interfaz',
  api: 'API',
  workflow: 'Automatización',
  connector: 'Conexión',
  browser: 'Navegador',
};

const SEARCH_SCOPE_LABEL: Record<string, string> = {
  marketplace: 'Marketplace',
  'command-palette': 'Buscador ⌘K',
  workflows: 'Automatizaciones',
  agents: 'Trabajadores',
  executions: 'Historial',
};

/* ---------------------------------------------------------------------------------------------- */
/* Formato                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

const fmtInt = (n: number): string => Math.round(n).toLocaleString();

/** `null` es «no hay dato» y se pinta como hueco. Un 0 diría «dura cero», que es otra afirmación. */
const fmtMs = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s % 60)).padStart(2, '0')} s`;
};

const fmtPct = (n: number): string => `${(n * 100).toFixed(n >= 0.1 || n === 0 ? 0 : 1)} %`;

/**
 * Media de permanencia. Divide por `dwellSamples`, NUNCA por las vistas: las vistas meten en el
 * denominador eventos que no midieron nada y hunden la media sin que se note. Sin muestras no hay media.
 */
const avgDwell = (r: { dwellMs: number; dwellSamples: number }): number | null =>
  r.dwellSamples > 0 ? r.dwellMs / r.dwellSamples : null;

const ratio = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);

/* ---------------------------------------------------------------------------------------------- */
/* Piezas de la página                                                                              */
/* ---------------------------------------------------------------------------------------------- */

function Section({
  title,
  hint,
  note,
  icon,
  children,
}: {
  title: string;
  hint?: string;
  note?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-2.5 border-b border-border px-5 py-3">
        {icon && <span className="mt-0.5 text-txt-secondary">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-txt-primary">{title}</h2>
          {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-txt-secondary">{hint}</p>}
        </div>
      </div>
      <div className="px-5 py-4">{children}</div>
      {note && (
        <p className="border-t border-border bg-surface/60 px-5 py-2.5 text-[11px] leading-relaxed text-txt-disabled">{note}</p>
      )}
    </Card>
  );
}

/** Barra proporcional. Sin librería de gráficas: un div con un ancho es exactamente lo que hace falta. */
function Bar({ value, max, tone = 'bg-primary/70' }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
      <div className={cn('h-full rounded-full transition-[width] duration-300', tone)} style={{ width: pct > 0 ? `${Math.max(pct, 2)}%` : '0%' }} />
    </div>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <div className="space-y-3">{children}</div>;
}

function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

/** Hueco de sección. Nunca un 0: un cero se lee como medición y esto es ausencia de medición. */
function NoData({ title }: { title: string }) {
  const t = useT();
  return <EmptyState icon={<Inbox size={20} />} title={t(title)} description={t(NO_DATA)} />;
}

/** Muestras que sostienen una media. Va PEGADO a la media para que 3 muestras se vean como 3 muestras. */
function Samples({ n }: { n: number }) {
  const t = useT();
  return (
    <span className={cn('text-[11px] tabular-nums', n < 20 ? 'text-warning' : 'text-txt-disabled')}>
      {t('n=')}
      {fmtInt(n)}
    </span>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Secciones                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Cabecera. Las tres ventanas de «activos» son consultas propias (24 h / 7 d / 30 d) porque el número de
 * personas DISTINTAS de una semana no es la suma de las de cada día: alguien que entra el lunes y el
 * martes es una persona, no dos. Sumar los cubos diarios daría siempre de más.
 *
 * Cuando el rango elegido coincide con una de las tres ventanas, React Query reconoce la misma clave y no
 * repite la petición.
 */
function Headline({ q }: { q: InsightsQuery }) {
  const t = useT();
  const d1 = useInsightsOverview({ days: 1, scope: q.scope });
  const d7 = useInsightsOverview({ days: 7, scope: q.scope });
  const d30 = useInsightsOverview({ days: 30, scope: q.scope });
  const range = useInsightsOverview(q);

  const num = (v: number | undefined, loading: boolean) => (loading ? <Skeleton className="h-7 w-12" /> : fmtInt(v ?? 0));

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label={t('Activos · 24 h')} value={num(d1.data?.sessions.users, d1.isLoading)} icon={<Users size={18} />} tone="primary" />
        <Stat label={t('Activos · 7 días')} value={num(d7.data?.sessions.users, d7.isLoading)} icon={<Users size={18} />} tone="accent" />
        <Stat label={t('Activos · 30 días')} value={num(d30.data?.sessions.users, d30.isLoading)} icon={<Users size={18} />} tone="success" />
        <Stat
          label={`${t('Sesiones')} · ${q.days} ${t('días')}`}
          value={num(range.data?.sessions.sessions, range.isLoading)}
          delta={range.data ? `${range.data.sessions.eventsPerSession.toFixed(1)} ${t('eventos por sesión')}` : undefined}
          icon={<Activity size={18} />}
          tone="default"
        />
        {/* MEDIANA, no media: cuatro pestañas olvidadas ocho horas se llevan una media a donde quieran. */}
        <Stat
          label={t('Duración mediana de sesión')}
          value={range.isLoading ? <Skeleton className="h-7 w-16" /> : fmtMs(range.data?.sessions.medianDurationMs ?? null)}
          icon={<Clock size={18} />}
          tone="warning"
        />
      </div>
      <p className="text-[11px] leading-relaxed text-txt-disabled">
        {t(
          '«Activos» = personas distintas con al menos una sesión en esa ventana, contadas por ventana (no es la suma de los días). La duración es la mediana, no la media.',
        )}
      </p>
    </div>
  );
}

/** Pantallas más usadas. La permanencia va con su denominador a la vista. */
function Surfaces({ q }: { q: InsightsQuery }) {
  const t = useT();
  const { data, isLoading } = useInsightsOverview(q);
  const rows = [...(data?.surfaces ?? [])].sort((a, b) => b.views - a.views);
  const max = rows[0]?.views ?? 0;

  return (
    <Section title={t('Páginas más usadas')} hint={t('Vistas, sesiones que pasaron por ahí y cuánto se queda la gente.')} note={t(DWELL_NOTE)} icon={<Layers size={15} />}>
      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <NoData title="Sin visitas registradas" />
      ) : (
        <Rows>
          {rows.map((r) => {
            const avg = avgDwell(r);
            return (
              <div key={r.surface}>
                <div className="flex items-baseline justify-between gap-4">
                  <div className="min-w-0">
                    <span className="text-sm text-txt-primary">{t(SURFACE_LABEL[r.surface] ?? r.surface)}</span>
                    <span className="ml-2 font-mono text-[11px] text-txt-disabled">{r.surface}</span>
                  </div>
                  <div className="flex shrink-0 items-baseline gap-3 tabular-nums">
                    <span className="text-sm text-txt-primary">{fmtInt(r.views)}</span>
                    <span className="text-[11px] text-txt-secondary">
                      {fmtInt(r.sessions)} {t('sesiones')}
                    </span>
                    <span className="w-24 text-right text-[11px] text-txt-secondary">{fmtMs(avg)}</span>
                    <Samples n={r.dwellSamples} />
                  </div>
                </div>
                <div className="mt-1.5">
                  <Bar value={r.views} max={max} />
                </div>
              </div>
            );
          })}
        </Rows>
      )}
    </Section>
  );
}

/** Pestañas ordenadas por permanencia media: dónde se para la gente dentro de una pantalla. */
function TabsDwell({ q }: { q: InsightsQuery }) {
  const t = useT();
  const { data, isLoading } = useInsightsOverview(q);
  const rows = [...(data?.tabs ?? [])].sort((a, b) => (avgDwell(b) ?? 0) - (avgDwell(a) ?? 0));
  const max = rows.reduce((m, r) => Math.max(m, avgDwell(r) ?? 0), 0);

  return (
    <Section title={t('Pestañas por tiempo de permanencia')} hint={t('Media de permanencia por pestaña, con las muestras que la sostienen.')} note={t(DWELL_NOTE)} icon={<Clock size={15} />}>
      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <NoData title="Sin permanencia registrada" />
      ) : (
        <Rows>
          {rows.map((r) => {
            const avg = avgDwell(r);
            return (
              <div key={`${r.surface}:${r.tab}`}>
                <div className="flex items-baseline justify-between gap-4">
                  <div className="min-w-0">
                    <span className="text-sm text-txt-primary">{t(TAB_LABEL[r.tab] ?? r.tab)}</span>
                    <span className="ml-2 font-mono text-[11px] text-txt-disabled">{r.surface}</span>
                  </div>
                  <div className="flex shrink-0 items-baseline gap-3 tabular-nums">
                    <span className="w-24 text-right text-sm text-txt-primary">{fmtMs(avg)}</span>
                    <Samples n={r.dwellSamples} />
                  </div>
                </div>
                <div className="mt-1.5">
                  <Bar value={avg ?? 0} max={max} tone="bg-accent/70" />
                </div>
              </div>
            );
          })}
        </Rows>
      )}
    </Section>
  );
}

/** Panel de «lo más tocado» de un tipo. Los tres comparten forma, así que comparten componente. */
function TopEntities({
  q,
  name,
  entityType,
  title,
  hint,
  note,
  empty,
  unit,
}: {
  q: InsightsQuery;
  name: EventName;
  entityType: 'workflow' | 'connector' | 'template';
  title: string;
  hint: string;
  note?: string;
  empty: string;
  unit: string;
}) {
  const t = useT();
  const { data, isLoading } = useInsightsEntities({ ...q, name, entityType });
  const rows = data ?? [];
  const max = rows[0]?.count ?? 0;

  return (
    <Section title={t(title)} hint={t(hint)} note={note ? t(note) : undefined}>
      {isLoading ? (
        <Loading rows={3} />
      ) : rows.length === 0 ? (
        <NoData title={empty} />
      ) : (
        <Rows>
          {rows.slice(0, 10).map((r) => (
            <div key={r.entityId}>
              <div className="flex items-baseline justify-between gap-3">
                {/* Sin nombre resuelto se enseña el id: es lo que hay, y decirlo es mejor que inventarlo. */}
                <span className={cn('min-w-0 truncate text-sm', r.label ? 'text-txt-primary' : 'font-mono text-txt-secondary')}>
                  {r.label ?? r.entityId}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-txt-secondary">
                  {fmtInt(r.count)} <span className="text-txt-disabled">{t(unit)}</span>
                </span>
              </div>
              <div className="mt-1.5">
                <Bar value={r.count} max={max} />
              </div>
            </div>
          ))}
        </Rows>
      )}
    </Section>
  );
}

/**
 * Funciones que casi nadie usa. Ordenadas ASCENDENTE porque el informe va de eso: lo interesante está
 * abajo del ranking, no arriba. El cero es el dato, y por eso el endpoint cruza contra el inventario —una
 * función que no se dispara nunca no deja ni una fila que rankear—.
 *
 * `instrumentedSince` va al lado de cada cifra: separa «no la usa nadie» de «la medimos desde anteayer»,
 * que son la misma cifra y dos conclusiones opuestas.
 */
function ColdFeatures({ q }: { q: InsightsQuery }) {
  const t = useT();
  const { data, isLoading } = useInsightsFeatures(q);
  const rows = [...(data ?? [])].sort((a, b) => a.count - b.count || a.users - b.users);
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <Section
      title={t('Funciones que no usa casi nadie')}
      hint={t('De menos a más uso, cruzando el inventario de funciones: las que salen a cero están medidas y sin usar.')}
      note={t('«Medida desde» separa «no la usa nadie» de «la acabamos de instrumentar»: sin esa fecha, las dos cosas son la misma cifra.')}
      icon={<Sparkles size={15} />}
    >
      {isLoading ? (
        <Loading rows={6} />
      ) : rows.length === 0 ? (
        <NoData title="Sin inventario de funciones" />
      ) : (
        <Rows>
          {rows.slice(0, 15).map((r) => (
            <div key={`${r.kind}:${r.key}`}>
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm text-txt-primary">{r.label}</span>
                  <Badge tone="default">{r.kind}</Badge>
                  {r.count === 0 && <Badge tone="warning">{t('sin uso')}</Badge>}
                </div>
                <div className="flex shrink-0 items-baseline gap-3 tabular-nums">
                  <span className="text-sm text-txt-primary">{fmtInt(r.count)}</span>
                  <span className="text-[11px] text-txt-secondary">
                    {fmtInt(r.users)} {t('personas')}
                  </span>
                  <span className="w-28 text-right text-[11px] text-txt-disabled">
                    {t('medida desde')} {r.instrumentedSince}
                  </span>
                </div>
              </div>
              <div className="mt-1.5">
                <Bar value={r.count} max={max} tone="bg-warning/60" />
              </div>
            </div>
          ))}
        </Rows>
      )}
    </Section>
  );
}

function Errors({ q }: { q: InsightsQuery }) {
  const t = useT();
  const { data, isLoading } = useInsightsOverview(q);
  const rows = data?.errors ?? [];
  const max = rows[0]?.count ?? 0;

  return (
    <Section
      title={t('Errores más frecuentes')}
      hint={t('Por origen y código. El texto del error no se guarda nunca.')}
      icon={<AlertTriangle size={15} />}
    >
      {isLoading ? (
        <Loading rows={3} />
      ) : rows.length === 0 ? (
        <NoData title="Sin errores registrados" />
      ) : (
        <Rows>
          {rows.map((r) => (
            <div key={`${r.kind}:${r.code}`}>
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                  <Badge tone="danger">{t(ERROR_KIND_LABEL[r.kind] ?? r.kind)}</Badge>
                  <span className="truncate font-mono text-xs text-txt-secondary">{r.code}</span>
                </div>
                <div className="flex shrink-0 items-baseline gap-3 tabular-nums">
                  <span className="text-sm text-txt-primary">{fmtInt(r.count)}</span>
                  <span className="text-[11px] text-txt-secondary">
                    {fmtInt(r.users)} {t('personas')}
                  </span>
                </div>
              </div>
              <div className="mt-1.5">
                <Bar value={r.count} max={max} tone="bg-danger/60" />
              </div>
            </div>
          ))}
        </Rows>
      )}
    </Section>
  );
}

/** Calidad de la búsqueda. La mediana se pinta como hueco a propósito; ver `MEDIAN_NOTE`. */
function SearchQuality({ q }: { q: InsightsQuery }) {
  const t = useT();
  const { data, isLoading } = useInsightsSearch(q);
  const rows = data ?? [];

  return (
    <Section
      title={t('Búsqueda')}
      hint={t('Búsquedas, cuántas no dieron ningún resultado y qué se teclea. Lo que no encuentra nadie es lo que falta en el producto.')}
      note={t(MEDIAN_NOTE)}
      icon={<Search size={15} />}
    >
      {isLoading ? (
        <Loading rows={3} />
      ) : rows.length === 0 ? (
        <NoData title="Sin búsquedas registradas" />
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <div key={r.scope} className="rounded-lg border border-border bg-surface/50 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="text-sm text-txt-primary">{t(SEARCH_SCOPE_LABEL[r.scope] ?? r.scope)}</span>
                <div className="flex flex-wrap items-baseline gap-4 text-[11px] tabular-nums text-txt-secondary">
                  <span>
                    {fmtInt(r.searches)} {t('búsquedas')}
                  </span>
                  <span className={cn(ratio(r.zeroResults, r.searches) > 0.2 && 'text-warning')}>
                    {fmtInt(r.zeroResults)} {t('sin resultados')} ({fmtPct(ratio(r.zeroResults, r.searches))})
                  </span>
                  <span>
                    {fmtInt(r.selections)} {t('clics en un resultado')}
                  </span>
                  <span className="text-txt-disabled">
                    {t('mediana hasta el clic:')} {fmtMs(r.medianTimeToSelectMs)}
                  </span>
                </div>
              </div>
              {(r.topTerms ?? []).length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {/* Solo llegan los términos tecleados por 5+ personas distintas: el resto no sale del servidor. */}
                  {(r.topTerms ?? []).slice(0, 12).map((term) => (
                    <span key={term.text} className="rounded-md border border-border bg-elevated px-1.5 py-0.5 text-[11px] text-txt-secondary">
                      {term.text}{' '}
                      <span className="tabular-nums text-txt-disabled">
                        {fmtInt(term.users)} {t('pers.')}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Funnel({ q }: { q: InsightsQuery }) {
  const t = useT();
  const { data, isLoading } = useInsightsFunnel({ ...q, steps: FUNNEL_STEPS, windowMinutes: FUNNEL_WINDOW_MINUTES });
  const rows = [...(data ?? [])].sort((a, b) => a.stepIndex - b.stepIndex);
  const first = rows[0]?.users ?? 0;

  return (
    <Section
      title={t('Embudo')}
      hint={`${t('Personas que completan cada paso dentro de la misma sesión y en orden, con una ventana de')} ${FUNNEL_WINDOW_MINUTES} ${t('minutos')}.`}
      note={t('Cuenta recorridos dentro de UNA sesión: quien crea algo hoy y lo ejecuta mañana no aparece como conversión.')}
      icon={<Filter size={15} />}
    >
      {isLoading ? (
        <Loading rows={3} />
      ) : rows.length === 0 || first === 0 ? (
        <NoData title="Sin recorridos completos todavía" />
      ) : (
        <Rows>
          {rows.map((r) => (
            <div key={r.step}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm text-txt-primary">
                  <span className="mr-2 text-[11px] tabular-nums text-txt-disabled">{r.stepIndex + 1}</span>
                  {t(EVENT_LABEL[r.step] ?? r.step)}
                </span>
                <div className="flex shrink-0 items-baseline gap-3 tabular-nums">
                  <span className="text-sm text-txt-primary">{fmtInt(r.users)}</span>
                  <span className="w-24 text-right text-[11px] text-txt-secondary">
                    {r.stepIndex === 0 ? t('punto de partida') : `${fmtPct(r.conversionFromPrev)} ${t('del anterior')}`}
                  </span>
                </div>
              </div>
              <div className="mt-1.5">
                <Bar value={r.users} max={first} tone="bg-success/60" />
              </div>
            </div>
          ))}
        </Rows>
      )}
    </Section>
  );
}

/**
 * Retención por cohorte de alta. `cohortSize` cuenta la cohorte ENTERA (todos los que se dieron de alta
 * ese día, activos o no), así que el día 0 puede no ser el 100 %: eso es correcto, no un fallo.
 */
function Retention({ q }: { q: InsightsQuery }) {
  const t = useT();
  const { data, isLoading } = useInsightsRetention({ ...q, cohortDays: q.days });
  const rows = data ?? [];

  const cohorts = [...new Set(rows.map((r) => r.cohort))].sort().reverse();
  const allOffsets = [...new Set(rows.map((r) => r.dayOffset))].sort((a, b) => a - b);
  // Con ventanas largas la rejilla se vuelve ilegible: se queda con los hitos que se suelen mirar.
  const preferred = [0, 1, 2, 3, 7, 14, 21, 30, 60, 90];
  const offsets = allOffsets.length > 8 ? allOffsets.filter((o) => preferred.includes(o)) : allOffsets;

  const cell = new Map(rows.map((r) => [`${r.cohort}:${r.dayOffset}`, r]));
  const sizeOf = new Map(rows.map((r) => [r.cohort, r.cohortSize]));

  return (
    <Section
      title={t('Retención por cohorte')}
      hint={t('Cada fila es la gente que se dio de alta ese día; cada columna, si seguía apareciendo N días después.')}
      note={t('El tamaño de la cohorte incluye a todos los que se dieron de alta ese día, aparecieran luego o no: por eso el día 0 no siempre es el 100 %.')}
      icon={<Users size={15} />}
    >
      {isLoading ? (
        <Loading rows={5} />
      ) : cohorts.length === 0 ? (
        <NoData title="Sin cohortes todavía" />
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[520px] border-separate border-spacing-0.5 text-[11px]">
            <thead>
              <tr className="text-txt-disabled">
                <th className="px-2 py-1 text-left font-medium">{t('Alta')}</th>
                <th className="px-2 py-1 text-right font-medium">{t('Personas')}</th>
                {offsets.map((o) => (
                  <th key={o} className="px-2 py-1 text-center font-medium tabular-nums">
                    {t('D')}
                    {o}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.map((c) => {
                const size = sizeOf.get(c) ?? 0;
                return (
                  <tr key={c}>
                    <td className="whitespace-nowrap px-2 py-1 tabular-nums text-txt-secondary">{c}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-txt-primary">{fmtInt(size)}</td>
                    {offsets.map((o) => {
                      const r = cell.get(`${c}:${o}`);
                      // Sin fila no hay medición (aún no ha pasado ese día): hueco, no un 0 %.
                      if (!r) return <td key={o} className="px-2 py-1 text-center text-txt-disabled">·</td>;
                      const pct = ratio(r.retained, r.cohortSize);
                      return (
                        <td key={o} className="relative px-2 py-1 text-center">
                          <span className="absolute inset-0 rounded bg-primary" style={{ opacity: pct * 0.55 }} aria-hidden />
                          <span className="relative tabular-nums text-txt-primary">{fmtPct(pct)}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* Página                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

export function Analytics() {
  const t = useT();
  const [days, setDays] = useState<number>(30);
  const [allWorkspaces, setAllWorkspaces] = useState(false);

  const me = useInsightsMe();
  const platformAdmin = me.data?.platformAdmin ?? false;
  // Con la recogida apagada, TODO sale a cero. Un cero que parece una medición y no lo es engaña más que
  // una página en blanco, así que se dice arriba del todo y sin ambigüedad.
  const collecting = me.data?.collecting ?? true;
  // El ámbito solo se pide si de verdad se puede: sin ser administrador de plataforma, `scope=all` es un
  // 400 en toda la página. Si alguien pierde el permiso con el interruptor puesto, cae solo al suyo.
  const q: InsightsQuery = { days, scope: platformAdmin && allWorkspaces ? 'all' : undefined };

  const overview = useInsightsOverview(q);

  return (
    <Page className="space-y-6">
      <PageHeader
        title={t('Analítica')}
        subtitle={t('Cómo se usa Workestra de verdad: qué se toca, qué se abandona y qué no usa nadie.')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {platformAdmin && (
              <Tabs
                pillId="analytics-scope-pill"
                active={allWorkspaces ? 'all' : 'mine'}
                onChange={(k) => setAllWorkspaces(k === 'all')}
                tabs={[
                  { key: 'all', label: t('Toda la plataforma') },
                  { key: 'mine', label: t('Mi espacio') },
                ]}
              />
            )}
            <Tabs
              pillId="analytics-range-pill"
              active={String(days)}
              onChange={(k) => setDays(Number(k))}
              tabs={RANGES.map((d) => ({ key: String(d), label: `${d} ${t('días')}` }))}
            />
          </div>
        }
      />

      {!collecting && (
        <Card className="border-warning/40 bg-warning/5 p-4">
          <p className="text-sm font-medium text-txt-primary">{t('La recogida de datos está apagada')}</p>
          <p className="mt-1 text-xs leading-relaxed text-txt-secondary">
            {t('Todo lo que ves abajo está a cero porque no se está midiendo, no porque nadie use el producto. Para encenderla, pon ANALYTICS_ENABLED=true en el servicio de la API.')}
          </p>
        </Card>
      )}

      {overview.error ? (
        <EmptyState
          icon={<AlertTriangle size={20} />}
          title={t('No se pudo cargar la analítica')}
          description={t('Hace falta el permiso de analítica (propietario o administrador) y que la API esté en marcha.')}
        />
      ) : (
        <>
          <Headline q={q} />

          <div className="grid gap-4 xl:grid-cols-2">
            <Surfaces q={q} />
            <TabsDwell q={q} />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <TopEntities
              q={q}
              name="workflow.updated"
              entityType="workflow"
              title="Automatizaciones más editadas"
              hint="Ediciones guardadas en la ventana."
              empty="Sin ediciones registradas"
              unit="ediciones"
            />
            <TopEntities
              q={q}
              name="connector.connected"
              entityType="connector"
              title="Conexiones más usadas"
              hint="Conexiones completadas desde la interfaz."
              note={CONNECTOR_NOTE}
              empty="Sin conexiones registradas"
              unit="conexiones"
            />
            <TopEntities
              q={q}
              name="template.installed"
              entityType="template"
              title="Plantillas más instaladas"
              hint="Instalaciones desde el marketplace."
              empty="Sin instalaciones registradas"
              unit="instalaciones"
            />
          </div>

          <ColdFeatures q={q} />

          <div className="grid gap-4 xl:grid-cols-2">
            <Errors q={q} />
            <SearchQuality q={q} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Funnel q={q} />
            <Retention q={q} />
          </div>
        </>
      )}

      <p className="text-[11px] leading-relaxed text-txt-disabled">
        {t('Los datos vienen de rollups por hora y día, no de la tabla en crudo: lo de las últimas horas puede aparecer con retraso.')}
      </p>
    </Page>
  );
}
