import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Plus, Boxes, GitBranch, Play, Workflow as WorkflowIcon, Trash2, X } from 'lucide-react';
import { Page } from '../app/AppShell';
import { Card, Button, PageHeader, Badge, Dot, EmptyState, Skeleton, IconButton, Input } from '../ui';
import { useWorkflows } from '../lib/hooks';
import { api, type WorkflowDto } from '../lib/api';
import { STARTER_DOC, docToWorkflowGraph } from '../graph';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../editor/templates';
import { useT } from '../i18n';

/** Estado del diálogo «ponle nombre antes de crear». `template` null = empezar en blanco. */
type Namer = { open: boolean; name: string; template: WorkflowTemplate | null };
const CLOSED: Namer = { open: false, name: '', template: null };

export function Workflows() {
  const t = useT();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { data, isLoading } = useWorkflows();

  const [namer, setNamer] = useState<Namer>(CLOSED);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // «Nueva automatización» (Dashboard, paleta ⌘K…) llega con ?new=1: abrimos el diálogo de nombre en vez
  // de crear a ciegas, para que el nombre se elija SIEMPRE antes de crear.
  useEffect(() => {
    if (params.get('new') === '1') {
      params.delete('new');
      setParams(params, { replace: true });
      setErr(null); // no arrastrar un error de creación anterior al reabrir por ?new=1
      setNamer({ open: true, name: '', template: null });
    }
  }, [params]);

  const openBlank = () => {
    setErr(null);
    setNamer({ open: true, name: '', template: null });
  };
  const openTemplate = (tpl: WorkflowTemplate) => {
    setErr(null);
    setNamer({ open: true, name: t(tpl.name), template: tpl }); // prellenado con el nombre de la plantilla (editable)
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
      const doc = namer.template ? namer.template.doc : STARTER_DOC;
      const wf = await api.createWorkflow(name, docToWorkflowGraph(doc));
      await qc.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/workflows/${wf.id}`);
    } catch {
      setErr(t('No se pudo crear la automatización. Revisa la conexión con la API.'));
      setBusy(false);
    }
  };

  return (
    <Page className="space-y-6">
      <PageHeader
        title={t('Automatizaciones')}
        subtitle={t('Elige una plantilla o empieza en blanco. Cada automatización es un flujo visual.')}
      />

      {/* Galería de plantillas (M23): el primer contacto no es un lienzo en blanco. */}
      <div>
        <div className="mb-3 text-sm font-medium text-txt-secondary">{t('Empezar con una plantilla')}</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {WORKFLOW_TEMPLATES.map((tpl) => (
            <Card key={tpl.id} hover className="cursor-pointer p-4" onClick={() => openTemplate(tpl)}>
              <div className="text-2xl">{tpl.icon}</div>
              <div className="mt-2 text-sm font-semibold text-txt-primary">{t(tpl.name)}</div>
              <div className="mt-1 text-xs leading-relaxed text-txt-secondary">{t(tpl.description)}</div>
            </Card>
          ))}
          <Card hover className="flex cursor-pointer flex-col items-start justify-center border-dashed p-4" onClick={openBlank}>
            <Plus size={20} className="text-txt-secondary" />
            <div className="mt-2 text-sm font-semibold text-txt-primary">{t('Empezar en blanco')}</div>
            <div className="mt-1 text-xs text-txt-secondary">{t('Un lienzo vacío para diseñar desde cero.')}</div>
          </Card>
        </div>
      </div>

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
            <Button variant="primary" onClick={openBlank}>
              <Plus size={15} /> {t('Crear automatización')}
            </Button>
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
    </Page>
  );
}

/** Tarjeta de automatización con acción de borrado (confirmación en línea, como en Agentes). */
function WorkflowCard({ wf, index, onOpen }: { wf: WorkflowDto; index: number; onOpen: () => void }) {
  const t = useT();
  const qc = useQueryClient();
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
              {namer.template ? t('Puedes cambiar el nombre de la plantilla antes de crearla.') : t('Así la reconocerás en tu lista de automatizaciones.')}
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
