import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Download, ArrowRight, LinkIcon, Crown, Bot, Wrench } from 'lucide-react';
import type { ShareStripItem } from '@core/contracts';
import { api } from '../lib/api';
import { hasValidSession } from '../lib/auth';
import { installRecipe } from '../marketplace/install';
import type { InstallRecipe } from '../marketplace/catalog';
import { workflowGraphToDoc } from '../graph';
import { getNodeType } from '../editor/node-types';
import { Logo } from '../app/Logo';
import { Button, Skeleton, Badge } from '../ui';
import { useT } from '../i18n';

const cleanError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^HTTP \d+:\s*/, '');

/** «Google Sheets» a partir de la clave `google-sheets`. */
const providerName = (p: string) =>
  p
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** Frase «vas a necesitar…» para UN item estructural que se quitó al compartir. Clave i18n (español). */
function needLabel(item: ShareStripItem): string {
  switch (item.kind) {
    case 'connectorId':
      return item.provider ? `conectar tu ${providerName(item.provider)}` : 'conectar tus apps';
    case 'accountId':
      return 'elegir tu cuenta';
    case 'folderId':
      return 'elegir tu carpeta';
    case 'mcpServer':
      return 'poner la URL de tu servidor MCP';
    case 'header':
    case 'urlKey':
      return 'poner tu clave de API';
    case 'toolId':
      return 'elegir tus herramientas';
    default:
      return 'configurar lo tuyo';
  }
}

/** Marco público (sin AppShell): marca centrada, funciona sin sesión. */
function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh items-start justify-center bg-surface px-4 py-10 sm:py-16">
      <div className="w-full max-w-2xl">
        <div className="mb-7 flex flex-col items-center text-center">
          <Logo size={40} className="text-txt-primary" />
          <div className="mt-3 text-lg font-semibold tracking-tight text-txt-primary">Workestra</div>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Importar un workflow compartido por enlace (M85). Ruta PÚBLICA `/import/:token`: se renderiza SIN sesión y
 * SIN AppShell. Muestra el flujo compartido en solo-lectura (pasos, asistentes, qué harás falta conectar) y,
 * al importar, reusa el MISMO camino que el marketplace (`installRecipe`) con una receta armada desde el doc
 * portable. Si no hay sesión, manda a /login?next=… para volver aquí tras entrar.
 */
export function ImportShare() {
  const t = useT();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const loggedIn = hasValidSession();

  const { data, isLoading, error } = useQuery({
    queryKey: ['share', token],
    queryFn: () => api.getShare(token as string),
    enabled: !!token,
    retry: false,
  });

  // Conectores del usuario (solo si hay sesión): para dejar los nodos cableados a lo que ya tiene conectado.
  const { data: connectors } = useQuery({
    queryKey: ['connectors'],
    queryFn: api.listConnectors,
    enabled: loggedIn,
    retry: false,
  });
  const connectorIdByProvider = useMemo(
    () => new Map((connectors ?? []).filter((c) => c.status === 'connected').map((c) => [c.provider, c.id] as const)),
    [connectors],
  );

  const [importing, setImporting] = useState(false);
  const [err, setErr] = useState('');

  // Pasos del flujo en etiquetas humanas (reusa el registro del editor). Se omite el nodo «Fin».
  const steps = useMemo(() => {
    const nodes = data?.doc.graph.nodes ?? [];
    return nodes
      .filter((n) => n.type !== 'end')
      .map((n) => {
        const def = getNodeType(n.type);
        return { key: n.key, label: def?.label ?? n.type, Icon: def?.icon };
      });
  }, [data]);

  // «Vas a necesitar…»: derivado de lo que se quitó al compartir, deduplicado.
  const needs = useMemo(() => {
    const out: string[] = [];
    for (const s of data?.report.structuralStrip ?? []) {
      const label = needLabel(s);
      if (!out.includes(label)) out.push(label);
    }
    return out;
  }, [data]);

  const doImport = async () => {
    if (!token) return;
    if (!loggedIn) {
      navigate(`/login?next=/import/${token}`);
      return;
    }
    if (!data || importing) return;
    setImporting(true);
    setErr('');
    try {
      const doc = data.doc;
      // El doc portable trae los marcadores del marketplace (`agentRef`, `provider`) dentro de la config;
      // `installRecipe` los resuelve igual que una plantilla. El grafo (contrato) se pasa a GraphDoc del editor.
      const recipe: InstallRecipe = {
        agents: doc.agents.map((a) => ({
          ref: a.ref,
          name: a.name,
          emoji: '🤖',
          role: a.role ?? '',
          systemPrompt: a.systemPrompt,
          model: a.model,
          tools: a.tools,
          isOrchestrator: a.isOrchestrator,
        })),
        workflow: { name: doc.name, doc: workflowGraphToDoc(doc.graph) },
      };
      const res = await installRecipe(recipe, connectorIdByProvider);
      await api.importShare(token); // cuenta la instalación (bump)
      if (res.workflowId) navigate(`/workflows/${res.workflowId}`);
      else navigate('/agents');
    } catch (e) {
      setErr(cleanError(e));
      setImporting(false);
    }
  };

  if (isLoading) {
    return (
      <PublicShell>
        <div className="space-y-3 rounded-2xl border border-border bg-elevated p-6 shadow-card">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </PublicShell>
    );
  }

  if (error || !data) {
    return (
      <PublicShell>
        <div className="rounded-2xl border border-border bg-elevated p-8 text-center shadow-card">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-elevated text-txt-disabled">
            <LinkIcon size={22} />
          </div>
          <h1 className="text-base font-semibold text-txt-primary">{t('Este enlace ya no está disponible')}</h1>
          <p className="mx-auto mt-1 max-w-sm text-sm text-txt-secondary">
            {t('Puede que haya caducado o que quien lo compartió lo haya revocado. Pídele un enlace nuevo.')}
          </p>
          <p className="mt-5 text-xs text-txt-secondary">
            <Link to="/" className="font-medium text-primary hover:underline">
              {t('Ir a Workestra')}
            </Link>
          </p>
        </div>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <div className="overflow-hidden rounded-2xl border border-border bg-elevated shadow-card">
        {/* Cabecera */}
        <div className="border-b border-border p-6">
          <div className="text-[11px] font-medium uppercase tracking-wide text-txt-disabled">{t('Te han compartido una automatización')}</div>
          <h1 className="mt-1 text-xl font-semibold text-txt-primary">{data.name}</h1>
          <p className="mt-1 text-sm text-txt-secondary">
            {t('Vista previa de solo lectura. Al importar, crearemos una copia en tu cuenta con tus asistentes y tu flujo.')}
          </p>
        </div>

        <div className="space-y-6 p-6">
          {/* Pasos del flujo */}
          {steps.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-txt-primary">{t('Los pasos del flujo')}</h2>
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface p-3">
                {steps.map((s, i) => (
                  <span key={s.key} className="flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-txt-secondary">
                      {s.Icon && <s.Icon size={12} />} {t(s.label)}
                    </span>
                    {i < steps.length - 1 && <span className="text-txt-disabled">→</span>}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Asistentes */}
          {data.doc.agents.length > 0 && (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-txt-primary">
                <Bot size={15} /> {t('Los asistentes')} · {data.doc.agents.length}
              </h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {data.doc.agents.map((a) => (
                  <div key={a.ref} className="rounded-lg border border-border bg-surface p-3">
                    <div className="flex items-center gap-1 text-sm font-medium text-txt-primary">
                      {t(a.name)}
                      {a.isOrchestrator && <Crown size={12} className="text-amber-400" />}
                    </div>
                    {a.role && <div className="mt-0.5 text-xs text-txt-disabled">{t(a.role)}</div>}
                    {a.tools.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {a.tools.map((tl) => (
                          <span key={tl} className="inline-flex items-center gap-1 rounded bg-card px-1.5 py-0.5 text-[10px] text-txt-secondary">
                            <Wrench size={9} /> {tl}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Vas a necesitar */}
          {needs.length > 0 && (
            <section className="rounded-lg border border-border bg-surface p-3">
              <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-txt-disabled">{t('Vas a necesitar')}</h2>
              <ul className="flex flex-wrap gap-1.5">
                {needs.map((n) => (
                  <li key={n}>
                    <Badge tone="default">{t(n)}</Badge>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-txt-disabled">
                {t('Podrás importarlo igualmente y configurar estos pasos después, en el editor.')}
              </p>
            </section>
          )}

          {err && <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{err}</div>}
        </div>

        {/* Pie: importar */}
        <div className="flex flex-col gap-2 border-t border-border p-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-txt-secondary">
            {loggedIn ? t('Se creará una copia en tu cuenta.') : t('Inicia sesión para importarlo a tu cuenta.')}
          </p>
          <Button variant="primary" onClick={doImport} disabled={importing} data-track="share-import">
            {importing ? <Loader2 size={15} className="animate-spin" /> : loggedIn ? <Download size={15} /> : <ArrowRight size={15} />}
            {loggedIn ? t('Importar a mi cuenta') : t('Iniciar sesión para importar')}
          </Button>
        </div>
      </div>
    </PublicShell>
  );
}
