import { useEffect, useRef, useState } from 'react';
import { Zap, Plus, Trash2, Plug, Copy, Check, KeyRound, TriangleAlert, Play } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button } from '../ui';
import { api } from '../lib/api';
import { useWebhooks, useSchedules, useConnectors, useTriggerBindings } from '../lib/hooks';
import { useAuth, canApprove } from '../lib/auth';
import { useEditorStore } from '../editor/store';
import { docToWorkflowGraph } from '../graph';
import { type Freq, WEEKDAYS, buildCron, humanCron, humanEvery, pad2 } from '../lib/cron';
import { ProviderLogo } from '../lib/provider-logos';
import { useT } from '../i18n';

/**
 * Formulario del nodo Trigger (M53): el usuario elige «cuándo arranca» EN el propio nodo y activa ahí
 * mismo el horario, el evento de Jira, el webhook o la carpeta de Google Drive — sin ir a otra página.
 * Reemplaza las tres tarjetas de la antigua página Conexiones. El value técnico del motor
 * ('manual'|'cron'|'webhook') se escribe en `config.event`; la elección humana queda en `config.eventId`.
 */

type EngineEvent = 'manual' | 'cron' | 'webhook';

const CHOICES: Array<{ id: string; label: string; engine: EngineEvent }> = [
  { id: 'manual', label: 'Manualmente (yo lo ejecuto)', engine: 'manual' },
  { id: 'schedule', label: 'En un horario', engine: 'cron' },
  { id: 'jira.issue_created', label: 'Cuando se crea un ticket de Jira', engine: 'webhook' },
  { id: 'jira.issue_updated', label: 'Cuando se actualiza un ticket de Jira', engine: 'webhook' },
  { id: 'google-drive.file_created', label: 'Cuando llega un fichero nuevo a Google Drive', engine: 'cron' },
  { id: 'webhook', label: 'Cuando llega un webhook (avanzado)', engine: 'webhook' },
];
const JIRA_LABELS: Record<string, string> = {
  'jira.issue_created': 'Cuando se crea un ticket de Jira',
  'jira.issue_updated': 'Cuando se actualiza un ticket de Jira',
};

type BindingLite = { eventId: string };
type ScheduleLite = { poll?: { provider: string } | null };

/**
 * Elección vigente: el `eventId` guardado si es válido; si no (workflows de antes de M53), se deriva de los
 * REGISTROS reales antes que del `event` del motor — un flujo con un evento de Jira activado desde la antigua
 * página Conexiones tiene `event: 'manual'` en el grafo, y sin esto abriría como «Manualmente» con su propio
 * disparador señalado como «resto de otro tipo» a borrar.
 */
function choiceOf(config: Record<string, unknown>, bindings?: BindingLite[], schedules?: ScheduleLite[]): string {
  const explicit = String(config.eventId ?? '');
  if (CHOICES.some((c) => c.id === explicit)) return explicit;
  const ev = config.event;
  const jira = (bindings ?? []).find((b) => JIRA_LABELS[b.eventId]);
  if (ev !== 'cron' && jira) return jira.eventId;
  if (ev === 'cron' && (schedules ?? []).some((s) => s.poll?.provider === 'google-drive') && !(schedules ?? []).some((s) => !s.poll)) {
    return 'google-drive.file_created';
  }
  return ev === 'cron' ? 'schedule' : ev === 'webhook' ? 'webhook' : 'manual';
}

/**
 * Guarda el grafo YA (sin esperar el autosave de 900 ms): el backend valida el evento del Trigger al crear
 * horarios/webhooks, así que el grafo persistido debe reflejar la elección antes de activar.
 */
async function flushGraph(wfId: string): Promise<void> {
  const doc = useEditorStore.getState().history.doc;
  await api.saveGraph(wfId, docToWorkflowGraph(doc));
}

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const SEL = 'h-8 w-full rounded-lg border border-border bg-surface px-2 text-xs text-txt-primary outline-none focus:border-primary/60';
const SEL_SM = 'h-8 rounded-lg border border-border bg-surface px-2 text-xs text-txt-primary outline-none focus:border-primary/60';
const ROW = 'flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 text-xs';
const DEL =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-txt-secondary hover:bg-danger/15 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-txt-secondary';

function CopyBtn({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-txt-secondary transition-colors hover:bg-elevated hover:text-txt-primary"
      aria-label={t('Copiar')}
    >
      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
    </button>
  );
}

/** Flujo de conexión OAuth de un proveedor: crea el conector si falta, abre el popup y sondea hasta conectar. */
function useProviderConnection(provider: string) {
  const [connecting, setConnecting] = useState(false);
  const [launching, setLaunching] = useState(false); // guard in-flight: evita el doble clic (conector duplicado)
  const popupRef = useRef<Window | null>(null);
  const { data: connectors } = useConnectors(connecting);
  const qc = useQueryClient();
  const connected = (connectors ?? []).find((c) => c.provider === provider && c.status === 'connected');
  useEffect(() => {
    if (connecting && connected) setConnecting(false);
  }, [connecting, connected]);
  // Si el usuario cierra el popup sin autorizar, re-habilita «Conectar» (con un margen por si SÍ autorizó
  // justo antes de cerrarse: el refetch de conectores termina de resolverlo).
  useEffect(() => {
    if (!connecting) return;
    const iv = window.setInterval(() => {
      if (popupRef.current?.closed) {
        window.clearInterval(iv);
        window.setTimeout(() => setConnecting(false), 2500);
      }
    }, 1000);
    return () => window.clearInterval(iv);
  }, [connecting]);
  const connect = async () => {
    if (launching || connecting) return;
    setLaunching(true);
    try {
      let existing = (connectors ?? []).find((c) => c.provider === provider);
      if (!existing) {
        const created = await api.createConnector(provider, `${provider}-1`);
        existing = { id: created.id, key: created.key, provider, status: 'disconnected', credentialsSecretId: null };
        await qc.invalidateQueries({ queryKey: ['connectors'] });
      }
      const { authorizeUrl } = await api.connectConnector(existing.id);
      popupRef.current = window.open(authorizeUrl, 'agentflow-oauth', 'width=540,height=680');
      if (!popupRef.current) throw new Error('No se pudo abrir la ventana de autorización (¿bloqueador de popups?).');
      setConnecting(true);
    } finally {
      setLaunching(false);
    }
  };
  return { connected, busy: launching || connecting, connect };
}

export function TriggerForm({
  nodeId,
  value,
  onChange,
}: {
  nodeId?: string;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const t = useT();
  const workflowId = useEditorStore((s) => s.workflowId);
  const doc = useEditorStore((s) => s.history.doc);
  const wfId = workflowId && workflowId !== 'local' ? workflowId : '';
  // El backend valida el PRIMER nodo Trigger del grafo: si este no es el que manda, avisamos en vez de
  // dejar activar algo que el servidor rechazaría con un error contradictorio.
  const governingId = doc.nodes.find((n) => n.kind === 'trigger')?.id;
  const isGoverning = !nodeId || !governingId || governingId === nodeId;
  const { data: bindings } = useTriggerBindings(wfId || null);
  const { data: schedules } = useSchedules(wfId || null);
  const choice = choiceOf(value, bindings, schedules);

  const select = (id: string) => {
    const def = CHOICES.find((c) => c.id === id);
    if (def) onChange({ ...value, event: def.engine, eventId: def.id });
  };

  if (!isGoverning) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
        <TriangleAlert size={13} className="mt-0.5 shrink-0" />
        <span>{t('Este flujo tiene varios pasos «Disparador»; manda el primero del lienzo. Configura el disparo en ese nodo (o borra este).')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-txt-secondary">{t('Cuándo arranca')}</span>
        <select value={choice} onChange={(e) => select(e.target.value)} className={SEL}>
          {CHOICES.map((c) => (
            <option key={c.id} value={c.id}>
              {t(c.label)}
            </option>
          ))}
        </select>
      </label>

      {choice === 'manual' && <p className="text-[11px] text-txt-disabled">{t('Este flujo arranca cuando pulses «Ejecutar».')}</p>}

      {!wfId ? (
        choice !== 'manual' && <p className="text-[11px] text-warning">{t('Guarda el workflow para poder activar disparadores.')}</p>
      ) : (
        <>
          {choice === 'schedule' && <ScheduleSection wfId={wfId} />}
          {choice.startsWith('jira.') && <JiraSection wfId={wfId} eventId={choice} />}
          {choice === 'webhook' && <WebhookSection wfId={wfId} />}
          {choice === 'google-drive.file_created' && <DriveSection wfId={wfId} />}
          <Leftovers wfId={wfId} choice={choice} />
        </>
      )}
    </div>
  );
}

/** «En un horario»: frecuencia en lenguaje natural → crea el horario y lista los activos. */
function ScheduleSection({ wfId }: { wfId: string }) {
  const t = useT();
  const { role } = useAuth();
  const qc = useQueryClient();
  const { data: schedules } = useSchedules(wfId);
  const [freq, setFreq] = useState<Freq>('daily');
  const [everyN, setEveryN] = useState(15);
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(1);
  const [monthday, setMonthday] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cron = buildCron(freq, everyN, hour, minute, weekday, monthday);
  const plain = (schedules ?? []).filter((s) => !s.poll); // los de sondeo (Drive) viven en su propia sección

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await flushGraph(wfId); // el backend exige que el Trigger guardado sea «cron»
      await api.createSchedule(wfId, { cron });
      await qc.invalidateQueries({ queryKey: ['schedules', wfId] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al programar'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setErr(null);
    try {
      await api.deleteSchedule(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al eliminar'));
    }
    await qc.invalidateQueries({ queryKey: ['schedules', wfId] });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <select value={freq} onChange={(e) => setFreq(e.target.value as Freq)} className={SEL_SM}>
          <option value="minutes">{t('Cada pocos minutos')}</option>
          <option value="hourly">{t('Cada hora')}</option>
          <option value="daily">{t('Cada día')}</option>
          <option value="weekly">{t('Cada semana')}</option>
          <option value="monthly">{t('Cada mes')}</option>
        </select>
        {freq === 'minutes' && (
          <select value={everyN} onChange={(e) => setEveryN(Number(e.target.value))} className={SEL_SM}>
            {[5, 10, 15, 30].map((n) => (
              <option key={n} value={n}>
                {t('cada')} {n} min
              </option>
            ))}
          </select>
        )}
        {freq === 'weekly' && (
          <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className={SEL_SM}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {t(d)}
              </option>
            ))}
          </select>
        )}
        {freq === 'monthly' && (
          <select value={monthday} onChange={(e) => setMonthday(Number(e.target.value))} className={SEL_SM}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {t('día')} {d}
              </option>
            ))}
          </select>
        )}
        {freq !== 'minutes' && (
          <span className="flex items-center gap-1 text-xs text-txt-secondary">
            <span>{freq === 'hourly' ? t('al minuto') : t('a las')}</span>
            {freq !== 'hourly' && (
              <select value={hour} onChange={(e) => setHour(Number(e.target.value))} className={SEL_SM}>
                {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                  <option key={h} value={h}>
                    {pad2(h)}
                  </option>
                ))}
              </select>
            )}
            {freq !== 'hourly' && <span>:</span>}
            <select value={minute} onChange={(e) => setMinute(Number(e.target.value))} className={SEL_SM}>
              {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                <option key={m} value={m}>
                  {pad2(m)}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>
      <p className="text-[11px] text-txt-secondary">
        {t('Se ejecutará:')} <span className="font-medium text-txt-primary">{humanCron(cron, t)}</span>
      </p>
      <Button size="sm" variant="primary" onClick={create} disabled={busy || !canApprove(role)}>
        <Plus size={13} /> {t('Programar')}
      </Button>
      {!canApprove(role) && <p className="text-[11px] text-warning">{t('El rol')} {role} {t('no puede programar (requiere workflow:write).')}</p>}
      {err && <p className="text-[11px] text-danger">{err}</p>}
      <div className="space-y-1.5">
        {plain.length === 0 ? (
          <p className="text-[11px] text-txt-disabled">{t('Este workflow no tiene triggers programados.')}</p>
        ) : (
          plain.map((s) => (
            <div key={s.id} className={ROW}>
              <Badge tone={s.active ? 'success' : 'default'}>{s.active ? t('Activo') : t('En pausa')}</Badge>
              <span className="min-w-0 flex-1 truncate text-txt-secondary">{s.cron ? humanCron(s.cron, t) : humanEvery(s.everyMs ?? 0)}</span>
              <button onClick={() => remove(s.id)} className={DEL} disabled={!canApprove(role)} aria-label={t('Eliminar')}>
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Evento de Jira: conectar + elegir proyecto + activar (AgentFlow registra el webhook EN Jira). */
function JiraSection({ wfId, eventId }: { wfId: string; eventId: string }) {
  const t = useT();
  const { role } = useAuth();
  const qc = useQueryClient();
  const { connected: jira, busy: connBusy, connect } = useProviderConnection('jira');
  const { data: bindings } = useTriggerBindings(wfId);
  const [projectKey, setProjectKey] = useState('');
  const [cloudId, setCloudId] = useState<string | undefined>(undefined);
  const [projects, setProjects] = useState<Array<{ key: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Reintento del listado de proyectos: `probe` re-dispara el effect (p. ej. tras «Reautorizar Jira», donde
  // el conector conserva el MISMO id y una dependencia solo en jira?.id dejaría «Cargando proyectos…» eterno).
  const [probe, setProbe] = useState(0);
  const retriesRef = useRef(0);

  useEffect(() => {
    if (!jira) {
      setProjects([]);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    api
      .jiraProjects(jira.id)
      .then((r) => {
        if (!alive) return;
        retriesRef.current = 0;
        setProjects(r.projects);
        setCloudId(r.cloudId);
        setProjectKey((cur) => (r.projects.some((p) => p.key === cur) ? cur : r.projects[0]?.key || ''));
      })
      .catch(() => {
        if (!alive) return;
        setProjects([]);
        // Auto-reintento acotado: se recupera solo cuando el usuario completa la reautorización.
        if (retriesRef.current < 20) {
          retriesRef.current += 1;
          timer = window.setTimeout(() => setProbe((p) => p + 1), 4000);
        }
      });
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [jira?.id, probe]);

  const doConnect = async () => {
    setErr(null);
    retriesRef.current = 0; // reabre la ventana de reintentos del listado de proyectos
    setProbe((p) => p + 1);
    try {
      await connect();
    } catch (e) {
      setErr(e instanceof Error ? t(e.message) : t('Error al conectar'));
    }
  };

  const activate = async () => {
    if (!jira || !projectKey) return;
    setBusy(true);
    setErr(null);
    try {
      // El backend registra el webhook EN Jira (URL estable por conector) y enruta por contenido.
      await api.createTriggerBinding(wfId, { eventId, connectorId: jira.id, params: { projectKey, cloudId } });
      await qc.invalidateQueries({ queryKey: ['triggerBindings', wfId] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al activar'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setErr(null);
    try {
      await api.deleteTriggerBinding(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al eliminar'));
    }
    await qc.invalidateQueries({ queryKey: ['triggerBindings', wfId] });
  };

  const jiraBindings = (bindings ?? []).filter((b) => b.eventId.startsWith('jira.'));

  return (
    <div className="flex flex-col gap-2">
      {!jira ? (
        <Button size="sm" variant="primary" onClick={doConnect} disabled={!canApprove(role) || connBusy}>
          <Plug size={13} /> {connBusy ? t('Conectando…') : t('Conectar Jira')}
        </Button>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-txt-secondary">{t('Proyecto de Jira')}</span>
            <select value={projectKey} onChange={(e) => setProjectKey(e.target.value)} className={SEL} disabled={projects.length === 0}>
              {projects.length === 0 && <option value="">{t('Cargando proyectos…')}</option>}
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="primary" onClick={activate} disabled={busy || !projectKey || !canApprove(role)}>
            <Zap size={13} /> {busy ? t('Activando…') : t('Activar disparador')}
          </Button>
          {projects.length === 0 && (
            <p className="text-[11px] text-txt-disabled">
              {t('¿No aparecen tus proyectos? Puede que Jira necesite el permiso nuevo.')}{' '}
              <button onClick={doConnect} className="font-medium text-primary underline">
                {t('Reautorizar Jira')}
              </button>
            </p>
          )}
        </>
      )}
      {!canApprove(role) && <p className="text-[11px] text-warning">{t('El rol')} {role} {t('no puede crear disparadores (requiere workflow:write).')}</p>}
      {err && <p className="text-[11px] text-danger">{err}</p>}
      <div className="space-y-1.5">
        {jiraBindings.length === 0 ? (
          <p className="text-[11px] text-txt-disabled">{t('Este flujo no tiene disparadores de apps conectadas.')}</p>
        ) : (
          jiraBindings.map((b) => (
            <div key={b.id} className={ROW}>
              <Badge tone={b.active ? 'accent' : 'default'}>
                <Check size={11} /> {t('Activo')}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-txt-secondary">
                {t(JIRA_LABELS[b.eventId] ?? b.eventId)}
                {b.params.projectKey ? ` · ${b.params.projectKey}` : ''}
              </span>
              <button onClick={() => remove(b.id)} className={DEL} disabled={!canApprove(role)} aria-label={t('Eliminar')}>
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Webhook firmado (HMAC-SHA256): crear, copiar la URL y guardar el secreto (se muestra una vez). */
function WebhookSection({ wfId }: { wfId: string }) {
  const t = useT();
  const { role } = useAuth();
  const qc = useQueryClient();
  const { data: webhooks } = useWebhooks(wfId);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<{ url: string; signingSecret: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setCreating(true);
    setErr(null);
    try {
      await flushGraph(wfId); // el backend exige que el Trigger guardado sea «webhook»
      const w = await api.createWebhook(wfId);
      setJustCreated({ url: w.url, signingSecret: w.signingSecret });
      await qc.invalidateQueries({ queryKey: ['webhooks', wfId] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al crear el webhook'));
    } finally {
      setCreating(false);
    }
  };
  const remove = async (id: string) => {
    setErr(null);
    try {
      await api.deleteWebhook(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al eliminar'));
    }
    await qc.invalidateQueries({ queryKey: ['webhooks', wfId] });
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-txt-disabled">{t('Arranca un workflow desde un evento externo. Cada endpoint se firma con HMAC-SHA256.')}</p>
      <Button size="sm" variant="primary" onClick={create} disabled={creating || !canApprove(role)}>
        <Plus size={13} /> {creating ? t('Creando…') : t('Nuevo webhook')}
      </Button>
      {!canApprove(role) && <p className="text-[11px] text-warning">{t('El rol')} {role} {t('no puede crear (requiere workflow:write).')}</p>}
      {justCreated && (
        <div className="space-y-2 rounded-lg border border-primary/25 bg-primary/[0.06] p-2.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
            <KeyRound size={12} /> {t('Guarda el secreto ahora — no se volverá a mostrar')}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] text-txt-primary">{API_BASE}{justCreated.url}</span>
            <CopyBtn value={`${API_BASE}${justCreated.url}`} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] text-txt-primary">{justCreated.signingSecret}</span>
            <CopyBtn value={justCreated.signingSecret} />
          </div>
          <p className="text-[11px] text-txt-secondary">
            {t('Firma el cuerpo:')} <span className="font-mono">x-agentflow-signature = HMAC_SHA256(body, secret)</span> {t('en hex.')}
          </p>
        </div>
      )}
      {err && <p className="text-[11px] text-danger">{err}</p>}
      <div className="space-y-1.5">
        {(webhooks ?? []).length === 0 ? (
          <p className="text-[11px] text-txt-disabled">{t('Este workflow aún no tiene webhooks.')}</p>
        ) : (
          (webhooks ?? []).map((w) => (
            <div key={w.id} className={ROW}>
              <Badge tone={w.active ? 'success' : 'default'}>{w.event}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-txt-secondary">{API_BASE}{w.url}</span>
              <CopyBtn value={`${API_BASE}${w.url}`} />
              <button onClick={() => remove(w.id)} className={DEL} disabled={!canApprove(role)} aria-label={t('Eliminar')}>
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Google Drive: conectar + carpeta + frecuencia de sondeo → crea el schedule con `poll` (M52). */
function DriveSection({ wfId }: { wfId: string }) {
  const t = useT();
  const { role } = useAuth();
  const qc = useQueryClient();
  const { connected: drive, busy: connBusy, connect } = useProviderConnection('google-drive');
  const { data: schedules } = useSchedules(wfId);
  const [folderId, setFolderId] = useState('');
  const [everyMin, setEveryMin] = useState(5);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const polls = (schedules ?? []).filter((s) => s.poll?.provider === 'google-drive');

  const doConnect = async () => {
    setErr(null);
    try {
      await connect();
    } catch (e) {
      setErr(e instanceof Error ? t(e.message) : t('Error al conectar'));
    }
  };

  const activate = async () => {
    if (!drive) return;
    setBusy(true);
    setErr(null);
    try {
      await flushGraph(wfId); // el sondeo es un schedule: el Trigger guardado debe ser «cron»
      await api.createSchedule(wfId, {
        everyMs: everyMin * 60_000,
        poll: { provider: 'google-drive', connectorId: drive.id, folderId: folderId.trim() || undefined },
      });
      await qc.invalidateQueries({ queryKey: ['schedules', wfId] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al activar'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setErr(null);
    try {
      await api.deleteSchedule(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al eliminar'));
    }
    await qc.invalidateQueries({ queryKey: ['schedules', wfId] });
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-txt-disabled">{t('AgentFlow vigilará la carpeta y arrancará el flujo por cada fichero nuevo, con el fichero listo para usar.')}</p>
      {!drive ? (
        <Button size="sm" variant="primary" onClick={doConnect} disabled={!canApprove(role) || connBusy}>
          <Plug size={13} /> {connBusy ? t('Conectando…') : t('Conectar Google Drive')}
        </Button>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-txt-secondary">{t('Carpeta de Drive')}</span>
            <input
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              placeholder={t('ID de la carpeta (vacío = toda tu unidad)')}
              className="h-8 w-full rounded-lg border border-border bg-surface px-2 font-mono text-xs text-txt-primary outline-none placeholder:font-sans placeholder:text-txt-disabled focus:border-primary/60"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-txt-secondary">
            {t('Comprobar cada')}
            <select value={everyMin} onChange={(e) => setEveryMin(Number(e.target.value))} className={SEL_SM}>
              {[1, 5, 15, 30].map((n) => (
                <option key={n} value={n}>
                  {n} min
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="primary" onClick={activate} disabled={busy || !canApprove(role)}>
            <Zap size={13} /> {busy ? t('Activando…') : t('Vigilar la carpeta')}
          </Button>
        </>
      )}
      {!canApprove(role) && <p className="text-[11px] text-warning">{t('El rol')} {role} {t('no puede crear disparadores (requiere workflow:write).')}</p>}
      {err && <p className="text-[11px] text-danger">{err}</p>}
      <div className="space-y-1.5">
        {polls.length === 0 ? (
          <p className="text-[11px] text-txt-disabled">{t('Este flujo aún no vigila ninguna carpeta.')}</p>
        ) : (
          polls.map((s) => (
            <div key={s.id} className={ROW}>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-white">
                <ProviderLogo provider="google-drive" size={13} />
              </span>
              <span className="min-w-0 flex-1 truncate text-txt-secondary">
                {s.poll?.folderId ? `${t('Carpeta')} ${s.poll.folderId}` : t('Toda tu unidad')} · {humanEvery(s.everyMs ?? 0)}
              </span>
              <button onClick={() => remove(s.id)} className={DEL} disabled={!canApprove(role)} aria-label={t('Eliminar')}>
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Restos de OTROS tipos de disparador: si el usuario cambia la elección pero deja horarios/webhooks/
 * eventos activos, SEGUIRÁN disparando. Se listan aquí con su papelera para que no queden fantasmas.
 */
function Leftovers({ wfId, choice }: { wfId: string; choice: string }) {
  const t = useT();
  const { role } = useAuth();
  const qc = useQueryClient();
  const { data: schedules } = useSchedules(wfId);
  const { data: webhooks } = useWebhooks(wfId);
  const { data: bindings } = useTriggerBindings(wfId);
  const [err, setErr] = useState<string | null>(null);

  const items: Array<{ key: string; label: string; remove: () => Promise<unknown> }> = [];
  for (const s of schedules ?? []) {
    if (s.poll && choice !== 'google-drive.file_created') {
      items.push({ key: `s-${s.id}`, label: `Google Drive · ${humanEvery(s.everyMs ?? 0)}`, remove: () => api.deleteSchedule(s.id) });
    } else if (!s.poll && choice !== 'schedule') {
      items.push({ key: `s-${s.id}`, label: s.cron ? humanCron(s.cron, t) : humanEvery(s.everyMs ?? 0), remove: () => api.deleteSchedule(s.id) });
    }
  }
  if (choice !== 'webhook') {
    for (const w of webhooks ?? []) items.push({ key: `w-${w.id}`, label: `Webhook ${w.url}`, remove: () => api.deleteWebhook(w.id) });
  }
  if (!choice.startsWith('jira.')) {
    for (const b of bindings ?? []) {
      items.push({
        key: `b-${b.id}`,
        label: `${t(JIRA_LABELS[b.eventId] ?? b.eventId)}${b.params.projectKey ? ` · ${b.params.projectKey}` : ''}`,
        remove: () => api.deleteTriggerBinding(b.id),
      });
    }
  }
  if (items.length === 0) return null;

  const removeItem = async (it: { remove: () => Promise<unknown> }) => {
    setErr(null);
    try {
      await it.remove();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al eliminar'));
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['schedules', wfId] }),
      qc.invalidateQueries({ queryKey: ['webhooks', wfId] }),
      qc.invalidateQueries({ queryKey: ['triggerBindings', wfId] }),
    ]);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-warning/25 bg-warning/10 p-2.5">
      <div className="flex items-start gap-1.5 text-[11px] text-warning">
        <TriangleAlert size={13} className="mt-0.5 shrink-0" />
        <span>{t('Este flujo aún tiene disparadores de otro tipo — seguirán ejecutándolo hasta que los quites.')}</span>
      </div>
      {items.map((it) => (
        <div key={it.key} className={ROW}>
          <Play size={11} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1 truncate text-txt-secondary">{it.label}</span>
          <button onClick={() => removeItem(it)} className={DEL} disabled={!canApprove(role)} aria-label={t('Eliminar')}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {err && <p className="text-[11px] text-danger">{err}</p>}
    </div>
  );
}
