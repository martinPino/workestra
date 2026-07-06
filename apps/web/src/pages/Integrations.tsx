import { useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { Webhook, Plus, Copy, Check, Trash2, ShieldAlert, KeyRound, Clock, Zap, Plug, Unplug, Lock } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkflowGraph } from '@core/contracts';
import { Page } from '../app/AppShell';
import { Card, Badge, Dot, PageHeader, Button } from '../ui';
import { useWorkflows, useWorkflow, useWebhooks, useSchedules, useConnectors, useConnectorProviders } from '../lib/hooks';
import { api } from '../lib/api';
import { useAuth, canApprove } from '../lib/auth';
import { useT } from '../i18n';

type TriggerEvent = 'manual' | 'webhook' | 'cron';

/** Evento del nodo Trigger del grafo: gobierna qué integración se puede crear (espejo del backend). */
function triggerEventOf(graph?: WorkflowGraph): TriggerEvent {
  const t = graph?.nodes.find((n) => n.type === 'trigger');
  const ev = (t?.config as { event?: string } | undefined)?.event;
  return ev === 'webhook' || ev === 'cron' ? ev : 'manual';
}

/** Aviso cuando el Trigger del workflow no coincide con la integración; enlaza al editor. */
function TriggerMismatch({ event, need, wfId }: { event: TriggerEvent; need: TriggerEvent; wfId: string }) {
  const t = useT();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
      <Zap size={13} />
      {t('El Trigger de este workflow es')} «{event}», {t('no')} «{need}».
      <Link to={`/workflows/${wfId}`} className="font-medium underline">
        {t('Cámbialo en el editor')}
      </Link>
      {t('para')} {need === 'webhook' ? t('crear webhooks') : t('programar disparos')}.
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
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
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

function WebhookManager() {
  const { data: workflows } = useWorkflows();
  const [workflowId, setWorkflowId] = useState<string>('');
  const wfId = workflowId || workflows?.[0]?.id || '';
  const { data: webhooks } = useWebhooks(wfId || null);
  const { data: wf } = useWorkflow(wfId || null);
  const triggerEvent = triggerEventOf(wf?.graph);
  const allowed = triggerEvent === 'webhook'; // el nodo Trigger debe ser de tipo webhook
  const { token, role } = useAuth();
  const t = useT();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<{ url: string; signingSecret: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    if (!wfId) return;
    setCreating(true);
    setErr(null);
    try {
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
    await api.deleteWebhook(id);
    await qc.invalidateQueries({ queryKey: ['webhooks', wfId] });
  };

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <Webhook size={17} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-txt-primary">Webhook triggers</div>
          <div className="text-xs text-txt-secondary">{t('Arranca un workflow desde un evento externo. Cada endpoint se firma con HMAC-SHA256.')}</div>
        </div>
      </div>

      {!token ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          <ShieldAlert size={14} /> {t('Necesitas una sesión (rol EDITOR o superior) para gestionar webhooks.')}{' '}
          <Link to="/settings" className="underline">
            {t('Generar token')}
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={wfId}
              onChange={(e) => {
                setWorkflowId(e.target.value);
                setJustCreated(null);
              }}
              className="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-txt-primary outline-none focus:border-primary/60"
            >
              {(workflows ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <Badge tone={allowed ? 'success' : 'default'}>
              <Zap size={11} /> trigger: {triggerEvent}
            </Badge>
            <Button size="sm" variant="primary" onClick={create} disabled={creating || !wfId || !allowed || !canApprove(role)}>
              <Plus size={14} /> {creating ? t('Creando…') : t('Nuevo webhook')}
            </Button>
            {!canApprove(role) && <span className="text-[11px] text-warning">{t('El rol')} {role} {t('no puede crear (requiere workflow:write).')}</span>}
          </div>
          {wfId && !allowed && <TriggerMismatch event={triggerEvent} need="webhook" wfId={wfId} />}

          {justCreated && (
            <div className="mt-3 space-y-2 rounded-lg border border-primary/25 bg-primary/[0.06] p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                <KeyRound size={12} /> {t('Guarda el secreto ahora — no se volverá a mostrar')}
              </div>
              <FieldRow label={t('URL (POST)')} value={`${API_BASE}${justCreated.url}`} mono />
              <FieldRow label={t('Signing secret')} value={justCreated.signingSecret} mono />
              <p className="text-[11px] text-txt-secondary">
                {t('Firma el cuerpo:')} <span className="font-mono">x-agentflow-signature = HMAC_SHA256(body, secret)</span> {t('en hex.')}
              </p>
            </div>
          )}
          {err && <p className="mt-2 text-xs text-danger">{err}</p>}

          <div className="mt-4 space-y-1.5">
            {(webhooks ?? []).length === 0 ? (
              <p className="text-xs text-txt-disabled">{t('Este workflow aún no tiene webhooks.')}</p>
            ) : (
              (webhooks ?? []).map((w) => (
                <div key={w.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
                  <Badge tone={w.active ? 'success' : 'default'}>{w.event}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-txt-secondary">{API_BASE}{w.url}</span>
                  <CopyButton value={`${API_BASE}${w.url}`} />
                  <button onClick={() => remove(w.id)} className="flex h-7 w-7 items-center justify-center rounded-md text-txt-secondary hover:bg-danger/15 hover:text-danger" aria-label={t('Eliminar')}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function humanEvery(ms: number): string {
  if (ms % 3_600_000 === 0) return `cada ${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `cada ${ms / 60_000} min`;
  if (ms % 1_000 === 0) return `cada ${ms / 1_000} s`;
  return `cada ${ms} ms`;
}

// --- Programador en lenguaje natural (M18): el usuario elige frecuencia + hora; generamos el cron ---
type Freq = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly';
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']; // cron: 0 = domingo
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Traduce las selecciones del picker a un patrón cron de 5 campos (min hora díaMes mes díaSem). */
function buildCron(freq: Freq, everyN: number, hour: number, minute: number, weekday: number, monthday: number): string {
  switch (freq) {
    case 'minutes':
      return `*/${everyN} * * * *`;
    case 'hourly':
      return `${minute} * * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekday}`;
    case 'monthly':
      return `${minute} ${hour} ${monthday} * *`;
    case 'daily':
    default:
      return `${minute} ${hour} * * *`;
  }
}

const isCronInt = (s: string) => /^\d+$/.test(s);

/**
 * Convierte a texto humano SOLO los crons con la forma que genera el picker; cualquier otra forma
 * (rangos «1-5», listas «0,12», pasos «* /5» en hora, etc.) cae con gracia al cron crudo — así un cron
 * legacy escrito a mano nunca se muestra como «NaN» o con un rango mal etiquetado. `t` traduce las piezas.
 */
function humanCron(cron: string, t: (s: string) => string): string {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [mi, ho, dom, mon, dow] = p;
  // «Cada pocos minutos»: */N * * * *
  const everyN = /^\*\/(\d+)$/.exec(mi);
  if (everyN && ho === '*' && dom === '*' && mon === '*' && dow === '*') return `${t('Cada')} ${everyN[1]} ${t('minutos')}`;
  if (!isCronInt(mi)) return cron;
  // «Cada hora, al minuto N»: N * * * *
  if (ho === '*' && dom === '*' && mon === '*' && dow === '*') return `${t('Cada hora, al minuto')} ${mi}`;
  if (!isCronInt(ho)) return cron;
  const at = `${pad2(Number(ho))}:${pad2(Number(mi))}`;
  // «Cada día a las HH:MM»: N N * * *
  if (dom === '*' && mon === '*' && dow === '*') return `${t('Cada día a las')} ${at}`;
  // «Cada <día de la semana> a las HH:MM»: N N * * D
  if (dom === '*' && mon === '*' && isCronInt(dow) && Number(dow) <= 6) return `${t('Cada')} ${t(WEEKDAYS[Number(dow)])} ${t('a las')} ${at}`;
  // «El día D de cada mes a las HH:MM»: N N D * *
  if (isCronInt(dom) && mon === '*' && dow === '*') return `${t('El día')} ${dom} ${t('de cada mes a las')} ${at}`;
  return cron; // forma no reconocida: cron crudo
}

function ScheduleManager() {
  const { data: workflows } = useWorkflows();
  const [workflowId, setWorkflowId] = useState<string>('');
  const wfId = workflowId || workflows?.[0]?.id || '';
  const { data: schedules } = useSchedules(wfId || null);
  const { data: wf } = useWorkflow(wfId || null);
  const triggerEvent = triggerEventOf(wf?.graph);
  const allowed = triggerEvent === 'cron'; // el nodo Trigger debe ser de tipo cron
  const { token, role } = useAuth();
  const t = useT();
  const qc = useQueryClient();
  const [freq, setFreq] = useState<Freq>('daily');
  const [everyN, setEveryN] = useState(15);
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(1); // lunes
  const [monthday, setMonthday] = useState(1);
  const [err, setErr] = useState<string | null>(null);

  const cron = buildCron(freq, everyN, hour, minute, weekday, monthday);
  const selCls = 'h-9 rounded-lg border border-border bg-surface px-2.5 text-sm text-txt-primary outline-none focus:border-primary/60';

  const create = async () => {
    if (!wfId) return;
    setErr(null);
    try {
      await api.createSchedule(wfId, { cron });
      await qc.invalidateQueries({ queryKey: ['schedules', wfId] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al programar'));
    }
  };
  const remove = async (id: string) => {
    await api.deleteSchedule(id);
    await qc.invalidateQueries({ queryKey: ['schedules', wfId] });
  };

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <Clock size={17} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-txt-primary">{t('En un horario')}</div>
          <div className="text-xs text-txt-secondary">{t('Haz que un flujo se ejecute solo, en el horario que elijas.')}</div>
        </div>
      </div>

      {!token ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          <ShieldAlert size={14} /> {t('Necesitas una sesión (rol EDITOR o superior) para programar triggers.')}{' '}
          <Link to="/settings" className="underline">
            {t('Generar token')}
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={wfId}
              onChange={(e) => setWorkflowId(e.target.value)}
              className="h-9 rounded-lg border border-border bg-surface px-3 text-sm text-txt-primary outline-none focus:border-primary/60"
            >
              {(workflows ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {/* Frecuencia en lenguaje natural (M18): genera el cron por debajo, sin sintaxis a la vista. */}
            <select value={freq} onChange={(e) => setFreq(e.target.value as Freq)} className={selCls}>
              <option value="minutes">{t('Cada pocos minutos')}</option>
              <option value="hourly">{t('Cada hora')}</option>
              <option value="daily">{t('Cada día')}</option>
              <option value="weekly">{t('Cada semana')}</option>
              <option value="monthly">{t('Cada mes')}</option>
            </select>

            {freq === 'minutes' && (
              <select value={everyN} onChange={(e) => setEveryN(Number(e.target.value))} className={selCls}>
                {[5, 10, 15, 30].map((n) => (
                  <option key={n} value={n}>{t('cada')} {n} min</option>
                ))}
              </select>
            )}
            {freq === 'weekly' && (
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className={selCls}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>{t(d)}</option>
                ))}
              </select>
            )}
            {freq === 'monthly' && (
              <select value={monthday} onChange={(e) => setMonthday(Number(e.target.value))} className={selCls}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{t('día')} {d}</option>
                ))}
              </select>
            )}
            {freq !== 'minutes' && (
              <div className="flex items-center gap-1.5 text-sm text-txt-secondary">
                <span>{freq === 'hourly' ? t('al minuto') : t('a las')}</span>
                {freq !== 'hourly' && (
                  <select value={hour} onChange={(e) => setHour(Number(e.target.value))} className={selCls}>
                    {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                      <option key={h} value={h}>{pad2(h)}</option>
                    ))}
                  </select>
                )}
                {freq !== 'hourly' && <span>:</span>}
                <select value={minute} onChange={(e) => setMinute(Number(e.target.value))} className={selCls}>
                  {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
                    <option key={m} value={m}>{pad2(m)}</option>
                  ))}
                </select>
              </div>
            )}
            <Button size="sm" variant="primary" onClick={create} disabled={!wfId || !allowed || !canApprove(role)}>
              <Plus size={14} /> {t('Programar')}
            </Button>
          </div>
          <p className="mt-2 text-xs text-txt-secondary">
            {t('Se ejecutará:')} <span className="font-medium text-txt-primary">{humanCron(cron, t)}</span>
          </p>
          {wfId && !allowed && <TriggerMismatch event={triggerEvent} need="cron" wfId={wfId} />}
          {!canApprove(role) && <p className="mt-1 text-[11px] text-warning">{t('El rol')} {role} {t('no puede programar (requiere workflow:write).')}</p>}
          {err && <p className="mt-2 text-xs text-danger">{err}</p>}

          <div className="mt-4 space-y-1.5">
            {(schedules ?? []).length === 0 ? (
              <p className="text-xs text-txt-disabled">{t('Este workflow no tiene triggers programados.')}</p>
            ) : (
              (schedules ?? []).map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
                  <Badge tone={s.active ? 'accent' : 'default'}>
                    <Clock size={11} /> {s.active ? t('Activo') : t('En pausa')}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-txt-secondary">{s.cron ? humanCron(s.cron, t) : humanEvery(s.everyMs ?? 0)}</span>
                  <button onClick={() => remove(s.id)} className="flex h-7 w-7 items-center justify-center rounded-md text-txt-secondary hover:bg-danger/15 hover:text-danger" aria-label={t('Eliminar')}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function FieldRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[11px] text-txt-secondary">{label}</span>
      <span className={`min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-txt-primary ${mono ? 'font-mono' : ''}`}>{value}</span>
      <CopyButton value={value} />
    </div>
  );
}

const PROVIDER_GRADIENT: Record<string, string> = {
  dev: 'from-fuchsia-500 to-purple-700',
  github: 'from-zinc-600 to-zinc-800',
  slack: 'from-purple-500 to-fuchsia-600',
};

/** Conectores OAuth (M11): conectar con el proveedor `dev` (funcional) y dispatch por el nodo Conector. */
function ConnectorsManager() {
  const { token, role } = useAuth();
  const t = useT();
  const { data: providers } = useConnectorProviders();
  const [connecting, setConnecting] = useState<string | null>(null);
  const { data: connectors } = useConnectors(!!connecting);
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  const byProvider = new Map((connectors ?? []).map((c) => [c.provider, c]));

  // Detiene el polling cuando el conector en curso pasa a `connected`.
  useEffect(() => {
    if (connecting && byProvider.get(connecting)?.status === 'connected') setConnecting(null);
  }, [connectors, connecting]);

  const connect = async (provider: string) => {
    setErr(null);
    try {
      let existing = byProvider.get(provider);
      if (!existing) {
        const created = await api.createConnector(provider, `${provider}-1`);
        existing = { id: created.id, key: created.key, provider, status: 'disconnected', credentialsSecretId: null };
        await qc.invalidateQueries({ queryKey: ['connectors'] });
      }
      const { authorizeUrl } = await api.connectConnector(existing.id);
      setConnecting(provider);
      window.open(authorizeUrl, 'agentflow-oauth', 'width=540,height=680');
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Error al conectar'));
    }
  };

  const disconnect = async (id: string) => {
    await api.deleteConnector(id);
    await qc.invalidateQueries({ queryKey: ['connectors'] });
  };

  return (
    <div>
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-txt-disabled">{t('Conectores')}</div>
      {!token ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
          <ShieldAlert size={14} /> {t('Necesitas una sesión (rol EDITOR o superior) para gestionar conectores.')}
        </div>
      ) : (
        <>
          {err && <p className="mb-2 text-xs text-danger">{err}</p>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {/* «Dev (mock)» es un proveedor de pruebas: se oculta al usuario final en producción (M16). */}
            {(providers ?? []).filter((p) => import.meta.env.DEV || p.provider !== 'dev').map((p, i) => {
              const c = byProvider.get(p.provider);
              const connected = c?.status === 'connected';
              return (
                <motion.div key={p.provider} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
                  <Card hover className="flex items-center gap-3 p-4">
                    <div className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${PROVIDER_GRADIENT[p.provider] ?? 'from-neutral-500 to-neutral-700'} text-lg font-bold text-white`}>
                      {p.label[0]}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-txt-primary">{p.label}</div>
                      {connected ? (
                        <Badge tone="success">
                          <Check size={11} /> {t('conectado')}
                        </Badge>
                      ) : p.configured ? (
                        <span className="text-xs text-txt-secondary">{t('sin conectar')}</span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-txt-disabled" title={`${t('Configura')} ${p.provider.toUpperCase()}_CLIENT_ID ${t('y')} ${p.provider.toUpperCase()}_CLIENT_SECRET ${t('en el servidor')}`}>
                          <Lock size={11} /> {t('falta')} {p.provider.toUpperCase()}_CLIENT_ID/SECRET
                        </span>
                      )}
                    </div>
                    {connected ? (
                      <Button size="sm" variant="secondary" onClick={() => disconnect(c!.id)} disabled={!canApprove(role)}>
                        <Unplug size={14} /> {t('Desconectar')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={p.configured ? 'primary' : 'secondary'}
                        onClick={() => connect(p.provider)}
                        disabled={!canApprove(role) || !p.configured || connecting === p.provider}
                      >
                        <Plug size={14} /> {connecting === p.provider ? t('Conectando…') : t('Conectar')}
                      </Button>
                    )}
                  </Card>
                </motion.div>
              );
            })}
          </div>
          {/* Nota para desarrolladores (config de servidor): oculta al usuario final en producción (M16). */}
          {import.meta.env.DEV && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-txt-disabled">
              <Dot tone="default" /> {t('«Dev» funciona sin configurar (OAuth simulado). Slack/Jira/GitHub se activan al fijar sus')} <span className="font-mono">*_CLIENT_ID/SECRET</span> {t('en el servidor y registrar la redirect URI')} <span className="font-mono">/connectors/callback</span>.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function Integrations() {
  const t = useT();
  return (
    <Page className="space-y-6">
      <PageHeader title={t('Integraciones')} subtitle={t('Triggers entrantes y conectores. Todo desacoplado como plugins.')} />

      <WebhookManager />

      <ScheduleManager />

      <ConnectorsManager />
    </Page>
  );
}
