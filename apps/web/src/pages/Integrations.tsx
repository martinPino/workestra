import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Check, ShieldAlert, Plug, Unplug, Lock, Zap } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Page } from '../app/AppShell';
import { Card, Badge, Dot, PageHeader, Button } from '../ui';
import { useConnectors, useConnectorProviders } from '../lib/hooks';
import { api } from '../lib/api';
import { ProviderLogo, hasProviderLogo } from '../lib/provider-logos';
import { useAuth, useCan } from '../lib/auth';
import { useT } from '../i18n';
import { useAnalytics } from '../analytics/useAnalytics';

const PROVIDER_GRADIENT: Record<string, string> = {
  dev: 'from-fuchsia-500 to-purple-700',
  github: 'from-zinc-600 to-zinc-800',
  slack: 'from-purple-500 to-fuchsia-600',
};

/** Conectores OAuth (M11): conectar con el proveedor `dev` (funcional) y dispatch por el nodo Conector. */
function ConnectorsManager() {
  const { token } = useAuth();
  const canManageConnectors = useCan('connector:write');
  const t = useT();
  const { data: providers } = useConnectorProviders();
  const [connecting, setConnecting] = useState<string | null>(null);
  const { data: connectors } = useConnectors(!!connecting);
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const { trackEvent } = useAnalytics();

  const byProvider = new Map((connectors ?? []).map((c) => [c.provider, c]));

  // Detiene el polling cuando el conector en curso pasa a `connected`.
  useEffect(() => {
    if (!connecting) return;
    const c = byProvider.get(connecting);
    if (c?.status !== 'connected') return;
    // M84: conectar de verdad no es pulsar el botón ni abrir el popup de OAuth — es que el sondeo vea el
    // conector en 'connected'. Antes de eso el conector no sirve para nada, y muchos abandonos viven ahí.
    trackEvent('connector.connected', { entityType: 'connector', entityId: c.id, props: { provider: connecting } });
    setConnecting(null);
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
                    {hasProviderLogo(p.provider) ? (
                      // Logo de marca real (Slack/Jira/GitHub) sobre fondo blanco, como en las apps oficiales.
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-white text-neutral-900">
                        <ProviderLogo provider={p.provider} size={24} />
                      </div>
                    ) : (
                      <div className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${PROVIDER_GRADIENT[p.provider] ?? 'from-neutral-500 to-neutral-700'} text-lg font-bold text-white`}>
                        {p.label[0]}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-txt-primary">{p.label}</div>
                      {connected ? (
                        <Badge tone="success">
                          <Check size={11} /> {t('conectado')}
                        </Badge>
                      ) : p.configured ? (
                        <span className="text-xs text-txt-secondary">{t('sin conectar')}</span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-txt-disabled" title={p.pkce ? `${t('Configura')} ${p.configProvider.toUpperCase()}_CLIENT_ID ${t('en el servidor')}` : `${t('Configura')} ${p.configProvider.toUpperCase()}_CLIENT_ID ${t('y')} ${p.configProvider.toUpperCase()}_CLIENT_SECRET ${t('en el servidor')}`}>
                          <Lock size={11} /> {t('falta')} {p.configProvider.toUpperCase()}_CLIENT_ID{p.pkce ? '' : '/SECRET'}
                        </span>
                      )}
                    </div>
                    {/* Gestionar conectores es de ADMIN (connector:write). Sin permiso ocultamos las acciones y dejamos solo la lectura. */}
                    {canManageConnectors && (connected ? (
                      <Button size="sm" variant="secondary" onClick={() => disconnect(c!.id)}>
                        <Unplug size={14} /> {t('Desconectar')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={p.configured ? 'primary' : 'secondary'}
                        onClick={() => connect(p.provider)}
                        disabled={!p.configured || connecting === p.provider}
                        data-track="connector-connect"
                      >
                        <Plug size={14} /> {connecting === p.provider ? t('Conectando…') : t('Conectar')}
                      </Button>
                    ))}
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
  const { trackEvent } = useAnalytics();

  // M84: apertura de Conexiones. Ref para que el doble montaje de StrictMode no cuente dos visitas.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    trackEvent('connector.opened');
  }, [trackEvent]);

  return (
    <Page className="space-y-6">
      <PageHeader title={t('Conexiones')} subtitle={t('Conecta las apps de tu equipo una vez; tus flujos las usan desde el editor.')} />

      {/* M53: los disparadores (horario, Jira, webhook, Drive) se configuran EN el nodo Disparador del editor. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/[0.06] px-3 py-2.5 text-xs text-txt-secondary">
        <Zap size={13} className="shrink-0 text-primary" />
        <span>{t('¿Cuándo se ejecuta un flujo? Ábrelo y toca su paso «Disparador»: ahí eliges horario, evento de Jira, webhook o carpeta de Google Drive.')}</span>
        <Link to="/workflows" className="font-medium text-primary underline">
          {t('Ir a mis workflows')}
        </Link>
      </div>

      <ConnectorsManager />
    </Page>
  );
}
