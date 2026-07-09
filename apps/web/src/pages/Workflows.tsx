import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Plus, Boxes, GitBranch, Play, Workflow as WorkflowIcon, Trash2, X, Sparkles, Plug, Copy, Check, KeyRound, Store } from 'lucide-react';
import { Page } from '../app/AppShell';
import { Card, Button, PageHeader, Badge, Dot, EmptyState, Skeleton, IconButton, Input, Textarea } from '../ui';
import { useWorkflows } from '../lib/hooks';
import { api, type WorkflowDto, type ApiKeyView } from '../lib/api';
import { STARTER_DOC, docToWorkflowGraph } from '../graph';
import { ThinkingSteps } from '../components/ThinkingSteps';
import { ModelKeysDialog } from '../components/ModelKeysDialog';
import { GENERATION_MODELS, DEFAULT_GENERATION_MODEL } from '../lib/models';
import { useCan } from '../lib/auth';
import { useT } from '../i18n';

/** Estado del diálogo «ponle nombre antes de crear». `template` null = empezar en blanco. */
type Namer = { open: boolean; name: string };
const CLOSED: Namer = { open: false, name: '' };

export function Workflows() {
  const t = useT();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { data, isLoading } = useWorkflows();
  const canWrite = useCan('workflow:write'); // crear/editar/publicar workflow
  const canManageKeys = useCan('apikey:manage'); // gestionar claves de IA del workspace (MCP/BYOK)

  const [namer, setNamer] = useState<Namer>(CLOSED);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // «Construir con IA» (M29) y «Usar por MCP» (fase 2): diálogos propios.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiModel, setAiModel] = useState(DEFAULT_GENERATION_MODEL); // M34: modelo elegido para «Construir con IA»
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);

  // «Nueva automatización» (Dashboard, paleta ⌘K…) llega con ?new=1: abrimos el diálogo de nombre en vez
  // de crear a ciegas, para que el nombre se elija SIEMPRE antes de crear.
  useEffect(() => {
    if (params.get('new') === '1') {
      params.delete('new');
      setParams(params, { replace: true });
      setErr(null); // no arrastrar un error de creación anterior al reabrir por ?new=1
      setNamer({ open: true, name: '' });
    }
  }, [params]);

  const openBlank = () => {
    setErr(null);
    setNamer({ open: true, name: '' });
  };
  const close = () => {
    if (busy) return;
    setErr(null);
    setNamer(CLOSED);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const name = namer.name.trim() || t('Mi automatización');
      const doc = STARTER_DOC;
      const wf = await api.createWorkflow(name, docToWorkflowGraph(doc));
      await qc.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/workflows/${wf.id}`);
    } catch {
      setErr(t('No se pudo crear la automatización. Revisa la conexión con la API.'));
      setBusy(false);
    }
  };

  const openAi = () => {
    setAiErr(null);
    setAiOpen(true);
  };
  const submitAi = async () => {
    if (aiBusy || !aiPrompt.trim()) return;
    setAiBusy(true);
    setAiErr(null);
    try {
      const { name, graph } = await api.generateWorkflow(aiPrompt.trim(), aiModel);
      const wf = await api.createWorkflow(name, graph);
      await qc.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/workflows/${wf.id}?ai=1`); // abre el chat de IA para seguir puliendo (M30)
    } catch (e) {
      // Muestra el motivo real del backend (p. ej. «el flujo debe tener un nodo de inicio») si lo hay.
      const detail = e instanceof Error ? (e.message.match(/^HTTP \d+:\s*(.+)/)?.[1] ?? '') : '';
      setAiErr(detail ? `${t('La IA no pudo montar el flujo.')} ${detail}` : t('La IA no pudo montar el flujo. Reformula la descripción o inténtalo de nuevo.'));
      setAiBusy(false);
    }
  };

  return (
    <Page className="space-y-6">
      <PageHeader
        title={t('Automatizaciones')}
        subtitle={t('Elige una plantilla o empieza en blanco. Cada automatización es un flujo visual.')}
      />

      {/* Selector de creación (M29): 3 formas de empezar — en blanco, con IA, o vía MCP.
          Crear workflow requiere 'workflow:write'; el MCP gestiona claves y requiere 'apikey:manage'. */}
      {(canWrite || canManageKeys) && (
        <div>
          <div className="mb-3 text-sm font-medium text-txt-secondary">{t('¿Cómo quieres empezar?')}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {canWrite && (
              <Card hover className="cursor-pointer p-4" onClick={openBlank}>
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-elevated text-txt-secondary">
                  <Plus size={18} />
                </div>
                <div className="mt-2.5 text-sm font-semibold text-txt-primary">{t('Empezar en blanco')}</div>
                <div className="mt-1 text-xs text-txt-secondary">{t('Un lienzo vacío para diseñar a mano.')}</div>
              </Card>
            )}

            {canWrite && (
              <Card hover className="cursor-pointer border-primary/30 p-4" onClick={openAi}>
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <Sparkles size={18} />
                </div>
                <div className="mt-2.5 flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-txt-primary">{t('Construir con IA')}</span>
                  <Badge tone="primary">{t('nuevo')}</Badge>
                </div>
                <div className="mt-1 text-xs text-txt-secondary">{t('Descríbelo en tus palabras y la IA lo monta.')}</div>
              </Card>
            )}

            {canWrite && (
              <Card hover className="cursor-pointer p-4" onClick={() => navigate('/marketplace')}>
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-elevated text-txt-secondary">
                  <Store size={18} />
                </div>
                <div className="mt-2.5 text-sm font-semibold text-txt-primary">{t('Empezar desde una plantilla')}</div>
                <div className="mt-1 text-xs text-txt-secondary">{t('Explora equipos, agentes y automatizaciones en el Marketplace.')}</div>
              </Card>
            )}

            {canManageKeys && (
              <Card hover className="cursor-pointer p-4" onClick={() => setMcpOpen(true)}>
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-elevated text-txt-secondary">
                  <Plug size={18} />
                </div>
                <div className="mt-2.5 flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-txt-primary">{t('Usar desde tu IA (MCP)')}</span>
                  <Badge tone="primary">{t('nuevo')}</Badge>
                </div>
                <div className="mt-1 text-xs text-txt-secondary">{t('Ejecútalo desde Claude, Cursor o ChatGPT.')}</div>
              </Card>
            )}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon size={22} />}
          title={t('Aún no hay automatizaciones')}
          description={t('Crea tu primera automatización y empieza a orquestar tus tareas.')}
          action={
            canWrite ? (
              <Button variant="primary" onClick={openBlank}>
                <Plus size={15} /> {t('Crear automatización')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((wf, i) => (
            <WorkflowCard key={wf.id} wf={wf} index={i} onOpen={() => navigate(`/workflows/${wf.id}`)} />
          ))}
        </div>
      )}

      {namer.open && (
        <NameDialog
          namer={namer}
          busy={busy}
          err={err}
          onName={(name) => setNamer((n) => ({ ...n, name }))}
          onSubmit={submit}
          onClose={close}
        />
      )}
      {aiOpen && (
        <AiDialog
          prompt={aiPrompt}
          model={aiModel}
          onModel={setAiModel}
          busy={aiBusy}
          err={aiErr}
          onPrompt={setAiPrompt}
          onSubmit={submitAi}
          onClose={() => {
            if (aiBusy) return;
            setAiOpen(false);
            setAiErr(null);
          }}
        />
      )}
      {mcpOpen && <McpDialog onClose={() => setMcpOpen(false)} />}
    </Page>
  );
}

/** Envoltorio de modal reutilizable (backdrop + Escape para cerrar). */
function Modal({ label, onClose, children, wide }: { label: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" aria-label="Cerrar" className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className={`relative w-full ${wide ? 'max-w-lg' : 'max-w-md'} rounded-xl border border-border bg-surface p-5 shadow-lg`}
      >
        {children}
      </motion.div>
    </div>
  );
}

/** «Construir con IA»: describe la automatización y la IA la monta. */
function AiDialog({
  prompt,
  model,
  onModel,
  busy,
  err,
  onPrompt,
  onSubmit,
  onClose,
}: {
  prompt: string;
  model: string;
  onModel: (v: string) => void;
  busy: boolean;
  err: string | null;
  onPrompt: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [keysOpen, setKeysOpen] = useState(false); // M35: diálogo «usa tu propia clave»
  const examples = [
    t('Cuando llegue un ticket, resúmelo con IA y avísame por Slack.'),
    t('Cada mañana, crea una hoja de cálculo con una idea del día.'),
  ];
  return (
    <Modal label={t('Construir con IA')} onClose={onClose} wide>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Sparkles size={16} />
          </span>
          <div>
            <h2 className="text-base font-semibold text-txt-primary">{t('Construir con IA')}</h2>
            <p className="mt-0.5 text-xs text-txt-secondary">{t('Describe qué quieres automatizar. La IA arma los pasos.')}</p>
          </div>
        </div>
        <IconButton onClick={onClose} aria-label={t('Cancelar')}>
          <X size={16} />
        </IconButton>
      </div>

      {busy ? (
        // Mientras la IA monta el flujo: mostramos tu petición + el «razonamiento» por pasos (M31).
        <div className="mt-4 space-y-3">
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary/15 px-3 py-2 text-xs leading-relaxed text-txt-primary">
              {prompt}
            </div>
          </div>
          <p className="text-xs leading-relaxed text-txt-secondary">
            {t('Voy a construir este flujo paso a paso: analizo lo que pides y elijo los nodos adecuados.')}
          </p>
          <ThinkingSteps />
        </div>
      ) : (
        <>
          <div className="mt-4">
            <Textarea
              autoFocus
              rows={4}
              value={prompt}
              onChange={(e) => onPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onSubmit();
                }
              }}
              placeholder={t('Ej.: cuando reciba un correo, resúmelo y mándalo a Slack #general.')}
              aria-label={t('Descripción de la automatización')}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {examples.map((ex) => (
                <button
                  key={ex}
                  onClick={() => onPrompt(ex)}
                  className="rounded-md border border-border bg-elevated px-2 py-1 text-[11px] text-txt-secondary hover:text-txt-primary"
                >
                  {ex}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <label className="text-xs text-txt-secondary">{t('Modelo de IA')}</label>
              <select
                value={model}
                onChange={(e) => onModel(e.target.value)}
                aria-label={t('Modelo de IA')}
                className="flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-txt-primary outline-none focus:border-primary/60"
              >
                {GENERATION_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setKeysOpen(true)} className="shrink-0 text-[11px] font-medium text-primary hover:underline">
                {t('Usa tu clave')}
              </button>
            </div>
            {err && <p className="mt-2 text-xs text-danger">{err}</p>}
          </div>
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t('Cancelar')}
            </Button>
            <Button variant="primary" onClick={onSubmit} disabled={busy || !prompt.trim()}>
              <Sparkles size={14} /> {t('Construir con IA')}
            </Button>
          </div>
        </>
      )}
      {keysOpen && <ModelKeysDialog onClose={() => setKeysOpen(false)} />}
    </Modal>
  );
}

/** Botón de copiar al portapapeles con feedback «copiado». */
function CopyBtn({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* portapapeles no disponible: no-op */
        }
      }}
      className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-elevated px-2 py-1 text-[11px] text-txt-secondary hover:text-txt-primary"
    >
      {done ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      {done ? t('Copiado') : t('Copiar')}
    </button>
  );
}

/**
 * «Usar desde tu IA (MCP)» (M32): genera/revoca claves de API y muestra la config para pegar en Claude
 * Desktop, Cursor o ChatGPT. La clave en claro se ve UNA sola vez al crearla.
 */
function McpDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{ rawKey: string } | null>(null);
  const [client, setClient] = useState<'claude' | 'cursor' | 'chatgpt'>('claude');

  const load = async () => {
    try {
      setKeys(await api.listApiKeys());
    } catch {
      setErr(t('No se pudieron cargar las claves. Revisa la conexión con la API.'));
    }
  };
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.createApiKey(label.trim() || 'MCP');
      setCreated({ rawKey: res.rawKey });
      setLabel('');
      await load();
    } catch {
      setErr(t('No se pudo crear la clave.'));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    try {
      await api.revokeApiKey(id);
      await load();
    } catch {
      setErr(t('No se pudo revocar la clave.'));
    }
  };

  const mcpUrl = created ? `${api.base}/mcp/${created.rawKey}` : '';
  const snippet =
    client === 'chatgpt'
      ? mcpUrl
      : JSON.stringify({ mcpServers: { agentflow: { url: mcpUrl } } }, null, 2);
  const clientHint: Record<typeof client, string> = {
    claude: t('Claude Desktop → Ajustes → Conectores → Añadir servidor MCP remoto, y pega la URL. O usa el bloque de config.'),
    cursor: t('Cursor → pega este bloque en ~/.cursor/mcp.json.'),
    chatgpt: t('ChatGPT → Ajustes → Conectores → Añadir, y pega esta URL.'),
  };

  return (
    <Modal label={t('Usar desde tu IA (MCP)')} onClose={onClose} wide>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Plug size={16} />
          </span>
          <div>
            <h2 className="text-base font-semibold text-txt-primary">{t('Conecta tu IA')}</h2>
            <p className="mt-0.5 text-xs text-txt-secondary">{t('Genera una clave y pégala en Claude Desktop, Cursor o ChatGPT para construir y ejecutar tus automatizaciones desde ahí.')}</p>
          </div>
        </div>
        <IconButton onClick={onClose} aria-label={t('Cerrar')}>
          <X size={16} />
        </IconButton>
      </div>

      {created ? (
        // Clave recién creada: se muestra UNA vez + la config lista para pegar.
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-txt-secondary">
            {t('Guarda esta clave ahora: por seguridad no volverás a verla. Si la pierdes, genera otra.')}
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-txt-primary">{created.rawKey}</code>
            <CopyBtn text={created.rawKey} label={t('Copiar clave')} />
          </div>
          <div className="flex gap-1.5">
            {(['claude', 'cursor', 'chatgpt'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setClient(c)}
                className={`rounded-md border px-2.5 py-1 text-[11px] ${client === c ? 'border-primary/50 bg-primary/12 text-primary' : 'border-border bg-card text-txt-secondary hover:text-txt-primary'}`}
              >
                {c === 'claude' ? 'Claude Desktop' : c === 'cursor' ? 'Cursor' : 'ChatGPT'}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-relaxed text-txt-secondary">{clientHint[client]}</p>
          <div className="relative rounded-lg border border-border bg-surface p-3">
            <div className="absolute right-2 top-2">
              <CopyBtn text={snippet} label={t('Copiar configuración')} />
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all pr-16 font-mono text-[11px] leading-relaxed text-txt-secondary">{snippet}</pre>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setCreated(null)}>
              {t('Hecho')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs text-txt-secondary">{t('Nombre de la clave (para reconocerla)')}</label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    create();
                  }
                }}
                placeholder={t('Mi Claude Desktop')}
              />
            </div>
            <Button variant="primary" onClick={create} disabled={busy}>
              <KeyRound size={14} /> {busy ? t('Generando…') : t('Generar clave')}
            </Button>
          </div>
          {err && <p className="text-xs text-danger">{err}</p>}

          <div>
            <div className="mb-1.5 text-xs font-medium text-txt-secondary">{t('Tus claves')}</div>
            {keys.length === 0 ? (
              <p className="text-xs text-txt-disabled">{t('Aún no has generado ninguna clave.')}</p>
            ) : (
              <div className="space-y-1.5">
                {keys.map((k) => (
                  <div key={k.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium text-txt-primary">{k.label}</span>
                        <code className="font-mono text-[11px] text-txt-disabled">af…{k.last4}</code>
                        {k.revokedAt && <Badge tone="danger">{t('revocada')}</Badge>}
                      </div>
                      <div className="mt-0.5 text-[10px] text-txt-disabled">
                        {k.lastUsedAt ? t('Último uso') + ': ' + new Date(k.lastUsedAt).toLocaleString() : t('Sin uso todavía')}
                      </div>
                    </div>
                    {!k.revokedAt && (
                      <Button variant="ghost" size="sm" onClick={() => revoke(k.id)} className="shrink-0 hover:text-danger">
                        {t('Revocar')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Tarjeta de automatización con acción de borrado (confirmación en línea, como en Agentes). */
function WorkflowCard({ wf, index, onOpen }: { wf: WorkflowDto; index: number; onOpen: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const canDelete = useCan('workflow:delete'); // borrar workflow
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const del = async () => {
    setDeleting(true);
    setErr(null);
    try {
      await api.deleteWorkflow(wf.id);
      await qc.invalidateQueries({ queryKey: ['workflows'] }); // la tarjeta desaparece al refrescar la lista
      setConfirming(false);
    } catch {
      // El catch evita la promesa sin manejar y deja la barra abierta con el aviso (no borra en silencio).
      setErr(t('No se pudo borrar la automatización. Revisa la conexión con la API.'));
    } finally {
      setDeleting(false);
    }
  };
  const cancel = () => {
    setConfirming(false);
    setErr(null);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }}>
      <Card hover className="group overflow-hidden">
        <div className="cursor-pointer p-5" onClick={onOpen}>
          <div className="flex items-start justify-between">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Boxes size={20} />
            </div>
            <div className="flex items-center gap-1">
              <Badge tone={wf.status === 'ACTIVE' ? 'success' : 'default'}>
                <Dot tone={wf.status === 'ACTIVE' ? 'success' : 'default'} /> {wf.status.toLowerCase()}
              </Badge>
              {canDelete && (
                <IconButton
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirming(true);
                  }}
                  aria-label={t('Borrar automatización')}
                  className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger"
                >
                  <Trash2 size={14} />
                </IconButton>
              )}
            </div>
          </div>
          <div className="mt-4 text-sm font-semibold text-txt-primary">{wf.name}</div>
          <div className="mt-1 flex items-center gap-3 text-xs text-txt-secondary">
            <span className="flex items-center gap-1">
              <GitBranch size={12} /> {wf.graph?.nodes?.length ?? 0} {t('nodos')}
            </span>
            <span>v{wf.version}</span>
          </div>
        </div>

        {confirming ? (
          <div className="border-t border-border bg-danger/5 px-5 py-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 text-xs text-txt-secondary">{t('¿Borrar con todo su historial?')}</span>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="danger" size="sm" onClick={del} disabled={deleting}>
                  {deleting ? t('Borrando…') : t('Borrar')}
                </Button>
                <Button variant="ghost" size="sm" onClick={cancel} disabled={deleting}>
                  {t('Cancelar')}
                </Button>
              </div>
            </div>
            {err && <p className="mt-2 text-[11px] text-danger">{err}</p>}
          </div>
        ) : (
          <div className="flex items-center justify-between border-t border-border px-5 py-3">
            <span className="text-xs text-txt-disabled">{t('Editar en el canvas')}</span>
            <button onClick={onOpen} className="flex items-center gap-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
              <Play size={12} /> {t('Abrir')}
            </button>
          </div>
        )}
      </Card>
    </motion.div>
  );
}

/** Diálogo modal para nombrar la automatización antes de crearla. */
function NameDialog({
  namer,
  busy,
  err,
  onName,
  onSubmit,
  onClose,
}: {
  namer: Namer;
  busy: boolean;
  err: string | null;
  onName: (name: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const t = useT();
  // Cerrar con Escape (patrón de diálogo modal accesible, como la paleta ⌘K). El foco inicial lo coloca
  // el autoFocus del Input; backdrop/X/Cancelar cierran también con ratón.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t('Nombrar automatización')}>
      <button type="button" aria-label={t('Cancelar')} className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-lg"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-txt-primary">{t('Ponle un nombre')}</h2>
            <p className="mt-0.5 text-xs text-txt-secondary">
              {t('Así la reconocerás en tu lista de automatizaciones.')}
            </p>
          </div>
          <IconButton onClick={onClose} aria-label={t('Cancelar')}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="mt-4">
          <Input
            autoFocus
            value={namer.name}
            onChange={(e) => onName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder={t('Mi automatización')}
            aria-label={t('Nombre de la automatización')}
          />
          {err && <p className="mt-2 text-xs text-danger">{err}</p>}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('Cancelar')}
          </Button>
          <Button variant="primary" onClick={onSubmit} disabled={busy}>
            {busy ? t('Creando…') : t('Crear')}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
