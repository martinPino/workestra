import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Star, Download, Clock, Users, Check, Loader2, Sparkles, Wrench, Plug, Puzzle, ListChecks, KeyRound, Crown } from 'lucide-react';
import { Page } from '../app/AppShell';
import { Button, Badge } from '../ui';
import { ProviderLogo, hasProviderLogo } from '../lib/provider-logos';
import { api } from '../lib/api';
import { useConnectors } from '../lib/hooks';
import { useCan } from '../lib/auth';
import { cn } from '../lib/cn';
import { useT } from '../i18n';
import { getMarketItem, KINDS } from '../marketplace/catalog';
import { installItem } from '../marketplace/install';

const cleanError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^HTTP \d+:\s*/, '');
const STEP_LABEL: Record<string, string> = { trigger: 'Disparador', llm: 'IA', agent: 'Agente', condition: 'Condición', connector: 'Conector', tool: 'Acción', router: 'Router', human: 'Aprobación', wait: 'Esperar', end: 'Fin', api: 'API' };

/** Chip de un conector requerido, con su estado y un botón «Conectar» en línea (inicia OAuth sin salir). */
function ConnectorRow({
  provider,
  connected,
  onConnect,
  connecting,
  canConnect,
}: {
  provider: string;
  connected: boolean;
  onConnect?: () => void;
  connecting?: boolean;
  canConnect?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        {hasProviderLogo(provider) ? (
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-white">
            <ProviderLogo provider={provider} size={16} />
          </span>
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-xs font-semibold text-txt-secondary">{provider[0]?.toUpperCase()}</span>
        )}
        <span className="text-sm capitalize text-txt-primary">{provider.replace(/-/g, ' ')}</span>
      </div>
      {connected ? (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
          <Check size={13} /> {t('Conectado')}
        </span>
      ) : onConnect && canConnect ? (
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
        >
          {connecting ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />} {t('Conectar')}
        </button>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-warning">{t('Falta conectar')}</span>
      )}
    </div>
  );
}

export function MarketplaceDetail() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const item = id ? getMarketItem(id) : undefined;
  const canInstall = useCan('workflow:write');
  const canConnect = useCan('connector:write');
  const qc = useQueryClient();

  const [wizardOpen, setWizardOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Sondea las conexiones mientras el asistente está abierto: al volver del OAuth, la fila pasa a «Conectado».
  const { data: connectors } = useConnectors(wizardOpen);

  const connectedProviders = useMemo(() => new Set((connectors ?? []).filter((c) => c.status === 'connected').map((c) => c.provider)), [connectors]);
  const connectorIdByProvider = useMemo(() => new Map((connectors ?? []).filter((c) => c.status === 'connected').map((c) => [c.provider, c.id] as const)), [connectors]);

  if (!item) {
    return (
      <Page className="max-w-3xl">
        <Link to="/marketplace" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><ArrowLeft size={15} /> {t('Volver al Marketplace')}</Link>
        <div className="mt-6 rounded-xl border border-border bg-elevated p-8 text-center text-sm text-txt-secondary">{t('Esta plantilla no existe.')}</div>
      </Page>
    );
  }

  const kind = KINDS.find((k) => k.key === item.kind);
  const missing = item.connectors.filter((p) => !connectedProviders.has(p));

  const doInstall = async () => {
    setInstalling(true);
    setError('');
    try {
      const res = await installItem(item, connectorIdByProvider);
      setWizardOpen(false);
      if (res.workflowId) navigate(`/workflows/${res.workflowId}`);
      else navigate('/agents');
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setInstalling(false);
    }
  };

  const onInstallClick = () => {
    if (item.connectors.length === 0) void doInstall();
    else setWizardOpen(true);
  };

  // M76: inicia el OAuth de un conector requerido SIN salir del asistente (crea el conector si no existe).
  const connect = async (provider: string) => {
    setError('');
    try {
      const list = connectors ?? [];
      let connectorId = list.find((c) => c.provider === provider)?.id;
      if (!connectorId) {
        const created = await api.createConnector(provider, `${provider}-1`);
        connectorId = created.id;
        await qc.invalidateQueries({ queryKey: ['connectors'] });
      }
      const { authorizeUrl } = await api.connectConnector(connectorId);
      setConnecting(provider);
      window.open(authorizeUrl, 'agentflow-oauth', 'width=540,height=680');
    } catch (e) {
      setError(cleanError(e));
    }
  };

  // Deja de marcar «conectando» cuando el proveedor pasa a conectado (lo detecta el sondeo).
  useEffect(() => {
    if (connecting && connectedProviders.has(connecting)) setConnecting(null);
  }, [connectedProviders, connecting]);

  return (
    <Page className="max-w-4xl space-y-6">
      <Link to="/marketplace" className="inline-flex items-center gap-1 text-sm text-txt-secondary hover:text-txt-primary"><ArrowLeft size={15} /> {t('Marketplace')}</Link>

      {/* Cabecera */}
      <div className="flex flex-wrap items-start gap-4">
        <span className={cn('flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-3xl shadow-subtle', item.gradient)}>{item.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] text-txt-disabled">
            <span>{kind?.icon} {t(kind?.label ?? '')}</span><span>·</span><span>{item.category}</span>
          </div>
          <h1 className="mt-0.5 text-2xl font-semibold text-txt-primary">{item.name}</h1>
          <p className="mt-1 text-sm text-txt-secondary">{t(item.tagline)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-txt-disabled">
            <span className="inline-flex items-center gap-1"><Star size={13} className="text-amber-400" /> {item.rating}</span>
            <span className="inline-flex items-center gap-1"><Download size={13} /> {item.installs.toLocaleString('es-ES')} {t('instalaciones')}</span>
            <span className="inline-flex items-center gap-1"><Clock size={13} /> {item.setupMinutes} min</span>
            <span>·</span><span>por {item.author}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <Button variant="primary" onClick={onInstallClick} disabled={!canInstall || installing}>
            {installing ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} {t('Instalar')}
          </Button>
          {!canInstall && <span className="text-[10px] text-txt-disabled">{t('Requiere permiso de edición')}</span>}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {item.badges.map((b) => (
          <Badge key={b} tone="default">{b}</Badge>
        ))}
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', item.difficulty === 'Fácil' ? 'bg-success/10 text-success' : item.difficulty === 'Media' ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger')}>{t(item.difficulty)}</span>
      </div>

      {error && <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</div>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Columna principal */}
        <div className="space-y-6 lg:col-span-2">
          <section>
            <h2 className="mb-1.5 text-sm font-semibold text-txt-primary">{t('Descripción')}</h2>
            <p className="text-sm leading-relaxed text-txt-secondary">{t(item.description)}</p>
          </section>

          {item.install.agents && item.install.agents.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-txt-primary"><Users size={15} /> {t('Agentes del equipo')} · {item.install.agents.length}</h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {item.install.agents.map((a) => (
                  <div key={a.ref} className="flex items-start gap-2.5 rounded-lg border border-border bg-elevated p-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-card text-base">{a.emoji}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-sm font-medium text-txt-primary">{t(a.name)}{a.isOrchestrator && <Crown size={12} className="text-amber-400" />}</div>
                      <div className="text-xs text-txt-disabled">{t(a.role)}</div>
                      {a.tools.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{a.tools.map((tl) => <span key={tl} className="rounded bg-card px-1.5 py-0.5 text-[10px] text-txt-secondary">{tl}</span>)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {item.install.workflow && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-txt-primary"><Sparkles size={15} /> {t('El flujo')}</h2>
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-elevated p-3">
                {item.install.workflow.doc.nodes
                  .filter((n) => n.kind !== 'end')
                  .map((n, i, arr) => (
                    <span key={n.id} className="flex items-center gap-1.5">
                      <span className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-txt-secondary">{t(STEP_LABEL[n.kind] ?? n.kind)}</span>
                      {i < arr.length - 1 && <span className="text-txt-disabled">→</span>}
                    </span>
                  ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-txt-primary"><ListChecks size={15} /> {t('Casos de uso')}</h2>
            <ul className="space-y-1">
              {item.useCases.map((u) => (
                <li key={u} className="flex items-center gap-2 text-sm text-txt-secondary"><Check size={13} className="text-success" /> {t(u)}</li>
              ))}
            </ul>
          </section>

          {item.variables && item.variables.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-txt-primary"><KeyRound size={15} /> {t('Variables configurables')}</h2>
              <div className="space-y-1.5">
                {item.variables.map((v) => (
                  <div key={v.key} className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-sm">
                    <span className="text-txt-primary">{t(v.label)}</span>
                    {v.example && <span className="font-mono text-[11px] text-txt-disabled">{v.example}</span>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Columna lateral: requisitos */}
        <div className="space-y-5">
          {item.connectors.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-txt-disabled"><Plug size={13} /> {t('Conectores')}</h3>
              <div className="space-y-1.5">
                {item.connectors.map((p) => (
                  <ConnectorRow key={p} provider={p} connected={connectedProviders.has(p)} />
                ))}
              </div>
            </section>
          )}
          {item.mcps.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-txt-disabled"><Puzzle size={13} /> MCP</h3>
              <div className="flex flex-wrap gap-1.5">
                {item.mcps.map((m) => (
                  <span key={m} className="rounded-lg border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-medium text-primary">{m}</span>
                ))}
              </div>
            </section>
          )}
          {item.tools.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-txt-disabled"><Wrench size={13} /> {t('Herramientas')}</h3>
              <div className="flex flex-wrap gap-1.5">
                {item.tools.map((tl) => (
                  <span key={tl} className="rounded-lg border border-border bg-card px-2 py-1 text-xs text-txt-secondary">{tl}</span>
                ))}
              </div>
            </section>
          )}
          {item.requirements && item.requirements.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-txt-disabled">{t('Requisitos')}</h3>
              <ul className="space-y-1">
                {item.requirements.map((r) => (
                  <li key={r} className="text-xs text-txt-secondary">• {t(r)}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {/* Asistente de credenciales / instalación */}
      {wizardOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button type="button" aria-label="Cerrar" className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !installing && setWizardOpen(false)} />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-elevated p-6 shadow-pop">
            <h2 className="text-base font-semibold text-txt-primary">{t('Antes de instalar')}</h2>
            <p className="mt-1 text-sm text-txt-secondary">
              {missing.length === 0
                ? t('Todas las conexiones necesarias están listas. Al instalar dejaremos el flujo cableado a tus conexiones.')
                : t('Esta solución usa estas conexiones. Puedes conectarlas ahora o instalar y hacerlo después (los pasos sin conectar quedarán marcados para configurar).')}
            </p>
            <div className="mt-4 space-y-1.5">
              {item.connectors.map((p) => (
                <ConnectorRow
                  key={p}
                  provider={p}
                  connected={connectedProviders.has(p)}
                  onConnect={() => connect(p)}
                  connecting={connecting === p}
                  canConnect={canConnect}
                />
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between gap-2">
              <Link to="/integrations" className="text-xs font-medium text-primary hover:underline">{t('Ir a Conexiones')}</Link>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => setWizardOpen(false)} disabled={installing}>{t('Cancelar')}</Button>
                <Button variant="primary" onClick={doInstall} disabled={installing}>
                  {installing ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  {missing.length === 0 ? t('Instalar') : t('Instalar de todas formas')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
