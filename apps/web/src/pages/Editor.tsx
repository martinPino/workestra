import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useOnSelectionChange,
  type Connection,
  type NodeChange,
  type ReactFlowInstance,
  type Node as RFNode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Undo2, Redo2, LayoutGrid, StickyNote, Play, Check, Boxes, Loader2, UploadCloud, PanelRightClose, PanelRightOpen, Menu, X, Sparkles } from 'lucide-react';
import { cn } from '../lib/cn';
import { useMediaQuery } from '../lib/useMediaQuery';
import type { ExecutionEvent } from '@core/contracts';
import { reduceExecution, type NodeRunStatus } from '@core/domain';
import { api } from '../lib/api';
import { subscribeExecution } from '../lib/socket';
import { computeLayout } from '../lib/layout';
import { AfNode } from '../nodes/AfNode';
import { CommentNode } from '../nodes/CommentNode';
import { PropertiesPanel } from '../components/PropertiesPanel';
import { AiChatPanel } from '../components/AiChatPanel';
import { SubtaskTree } from '../components/SubtaskTree';
import { docToReactFlow, docToWorkflowGraph, workflowGraphToDoc, STARTER_DOC } from '../graph';
import { listNodeTypes } from '../editor/node-types';
import { graphSetupIssues } from '../editor/node-issues';
import { useEditorStore } from '../editor/store';
import { useAgents, useConnectors } from '../lib/hooks';
import { statusLabel } from '../lib/labels';
import { Button, IconButton, Badge, Dot } from '../ui';
import { TriangleAlert } from 'lucide-react';
import { useT } from '../i18n';

function SelectionSync() {
  useOnSelectionChange({
    onChange: ({ nodes, edges }) => {
      const st = useEditorStore.getState();
      const ids = new Set(st.history.doc.nodes.map((n) => n.id));
      st.setSelection(
        nodes.map((n) => n.id).filter((id) => ids.has(id)),
        edges.map((e) => e.id),
      );
    },
  });
  return null;
}

const STATUS_TONE: Record<string, 'default' | 'primary' | 'success' | 'danger' | 'warning'> = {
  idle: 'default',
  QUEUED: 'default',
  RUNNING: 'primary',
  WAITING_HUMAN: 'warning',
  SUCCEEDED: 'success',
  FAILED: 'danger',
};

export function Editor() {
  const { id } = useParams();
  const doc = useEditorStore((s) => s.history.doc);
  const nodeStatus = useEditorStore((s) => s.nodeStatus);
  const selection = useEditorStore((s) => s.selection);
  const execStatus = useEditorStore((s) => s.execStatus);
  const workflowId = useEditorStore((s) => s.workflowId);
  const workflowName = useEditorStore((s) => s.workflowName);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const lastError = useEditorStore((s) => s.lastError);
  const s = useEditorStore.getState;
  const t = useT();

  const rf = useRef<ReactFlowInstance | null>(null);
  const dragStart = useRef<Record<string, { x: number; y: number }>>({});
  const [activated, setActivated] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle'); // indicador de autoguardado
  const skipFirstSave = useRef(true); // no autoguardar la carga inicial del grafo
  const dirtyRef = useRef(false); // hay cambios sin persistir (para el flush al salir)
  const wfRef = useRef(workflowId);
  wfRef.current = workflowId;
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [inspectorOpen, setInspectorOpen] = useState(isDesktop); // en móvil arranca cerrado (ver canvas)
  const [aiChatOpen, setAiChatOpen] = useState(false); // chat de IA para editar el flujo (M30)
  const [searchParams, setSearchParams] = useSearchParams();
  // Recién creado con «Construir con IA» (?ai=1): abre el chat para seguir puliendo, y cierra el inspector.
  useEffect(() => {
    if (searchParams.get('ai') === '1') {
      setAiChatOpen(true);
      setInspectorOpen(false);
      searchParams.delete('ai');
      setSearchParams(searchParams, { replace: true });
    }
  }, []);
  const nodeTypes = useMemo(() => ({ af: AfNode, comment: CommentNode }), []);
  const base = useMemo(() => docToReactFlow(doc, nodeStatus), [doc, nodeStatus]);

  // «Falta configurar» (M26): pasos que aún no funcionarían (app sin conectar, asistente sin elegir…).
  // Se pintan como aviso en cada nodo (AfNode) y bloquean Probar/Activar con un mensaje claro.
  const agentsQuery = useAgents();
  const connectorsQuery = useConnectors();
  const agents = agentsQuery.data;
  const connectors = connectorsQuery.data;
  const agentsError = agentsQuery.isError;
  const connectorsError = connectorsQuery.isError;
  const setupIssues = useMemo(
    () => graphSetupIssues(doc.nodes, { agents, connectors, agentsError, connectorsError }),
    [doc, agents, connectors, agentsError, connectorsError],
  );
  // Selección CONTROLADA por el store: en modo controlado React Flow ignora los cambios de
  // selección que no re-aplicamos, así que marcamos `selected` desde el store (lo puebla onNodeClick).
  const nodes = useMemo(() => base.nodes.map((n) => ({ ...n, selected: selection.includes(n.id) })), [base.nodes, selection]);
  const edges = base.edges;

  useEffect(() => {
    void (async () => {
      try {
        if (id) {
          const wf = await api.getWorkflow(id);
          s().loadDoc(wf.graph.nodes.length ? workflowGraphToDoc(wf.graph) : STARTER_DOC, { id: wf.id, name: wf.name });
        } else {
          const list = await api.listWorkflows();
          const wf = list[0] ? await api.getWorkflow(list[0].id) : await api.createWorkflow('Mi primer workflow', docToWorkflowGraph(STARTER_DOC));
          s().loadDoc(wf.graph.nodes.length ? workflowGraphToDoc(wf.graph) : STARTER_DOC, { id: wf.id, name: wf.name });
        }
      } catch {
        s().setError(t('No se pudo conectar con la API'));
        s().loadDoc(STARTER_DOC, { id: 'local', name: t('local (sin API)') });
      }
    })();
  }, [id]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moves = changes
      .filter((c): c is Extract<NodeChange, { type: 'position' }> => c.type === 'position' && !!c.position)
      .map((c) => ({ id: c.id, position: c.position! }));
    if (moves.length) s().setPositionsLive(moves);
  }, [s]);

  const onNodeDragStart = useCallback((_: unknown, __: unknown, dragged: RFNode[]) => {
    dragStart.current = Object.fromEntries(dragged.map((n) => [n.id, { ...n.position }]));
  }, []);

  const onNodeDragStop = useCallback((_: unknown, __: unknown, dragged: RFNode[]) => {
    const ids = new Set(s().history.doc.nodes.map((n) => n.id));
    const moves = dragged
      .filter((n) => ids.has(n.id))
      .map((n) => ({ id: n.id, from: dragStart.current[n.id] ?? n.position, to: n.position }))
      .filter((m) => m.from.x !== m.to.x || m.from.y !== m.to.y);
    s().commitMove(moves);
  }, [s]);

  const onConnect = useCallback((c: Connection) => {
    if (c.source && c.target) s().connect(c.source, c.target, c.sourceHandle);
  }, [s]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s().redo();
        else s().undo();
      } else if (mod && e.key.toLowerCase() === 'c') s().copySelection();
      else if (mod && e.key.toLowerCase() === 'v') s().paste();
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        s().removeSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s]);

  const addNode = (kind: string) => s().addNodeOfKind(kind, { x: 220 + Math.random() * 220, y: 120 + Math.random() * 220 });
  const autoLayout = () => {
    s().applyLayout(computeLayout(s().history.doc));
    setTimeout(() => rf.current?.fitView({ duration: 300 }), 0);
  };

  // Autoguardado (M17): el grafo se guarda solo, con debounce; sin botón «Guardar» ni modelo draft.
  useEffect(() => {
    if (!workflowId || workflowId === 'local') return undefined;
    if (skipFirstSave.current) {
      skipFirstSave.current = false;
      return undefined;
    }
    setSaveState('saving');
    setActivated(false); // hay cambios sin activar
    dirtyRef.current = true; // hay un cambio pendiente de persistir
    const timer = setTimeout(async () => {
      try {
        await api.saveGraph(workflowId, docToWorkflowGraph(s().history.doc));
        dirtyRef.current = false;
        setSaveState('saved');
      } catch {
        setSaveState('idle');
        s().setError(t('No se pudo guardar. Revisa que el flujo no tenga pasos en bucle.'));
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [doc, workflowId]);

  // Flush al salir (M17): si el usuario navega dentro de la ventana de debounce, el clearTimeout de arriba
  // cancela el guardado pendiente; este efecto de desmontaje persiste el último cambio para no perderlo.
  useEffect(
    () => () => {
      if (dirtyRef.current && wfRef.current && wfRef.current !== 'local') {
        void api.saveGraph(wfRef.current, docToWorkflowGraph(s().history.doc)).catch(() => undefined);
      }
    },
    [],
  );

  // «Activar» (M17): guarda y publica; a partir de ahí las ejecuciones (webhook, horario…) usan estos cambios.
  const handleActivate = async () => {
    if (!workflowId || workflowId === 'local') return;
    if (setupIssues.length) {
      s().setError(
        `${setupIssues.length} ${
          setupIssues.length === 1
            ? t('paso necesita configuración antes de activar. Revísalo (marcado con ⚠) en el lienzo.')
            : t('pasos necesitan configuración antes de activar. Revísalos (marcados con ⚠) en el lienzo.')
        }`,
      );
      return;
    }
    try {
      await api.saveGraph(workflowId, docToWorkflowGraph(s().history.doc));
      await api.publish(workflowId);
      setActivated(true);
      s().setError(t('Flujo activado. A partir de ahora funcionará con estos cambios.'));
    } catch {
      s().setError(t('No se pudo activar el flujo.'));
    }
  };

  const handleRun = async () => {
    if (!workflowId || workflowId === 'local') return;
    if (setupIssues.length) {
      s().setError(
        `${setupIssues.length} ${
          setupIssues.length === 1
            ? t('paso necesita configuración antes de probar. Revísalo (marcado con ⚠) en el lienzo.')
            : t('pasos necesitan configuración antes de probar. Revísalos (marcados con ⚠) en el lienzo.')
        }`,
      );
      return;
    }
    try {
      await api.saveGraph(workflowId, docToWorkflowGraph(s().history.doc));
      s().resetExec();
      const { executionId } = await api.execute(workflowId, { variables: { task: 'Coordina el workflow y ejecuta las subtareas.' } });
      s().beginExec();
      const buffer: ExecutionEvent[] = [];
      const unsub = subscribeExecution(api.base, executionId, (e) => {
        buffer.push(e);
        const state = reduceExecution(buffer);
        const map: Record<string, NodeRunStatus> = {};
        for (const [k, v] of Object.entries(state.nodes)) map[k] = v.status;
        s().applyExec(state.status, map, state.plan);
        if (state.status === 'SUCCEEDED' || state.status === 'FAILED') setTimeout(unsub, 400);
      });
    } catch {
      s().setError(t('Error al ejecutar'));
    }
  };

  const running = execStatus === 'RUNNING';
  const [paletteOpen, setPaletteOpen] = useState(false); // overlay de la paleta en móvil

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar (scroll horizontal en móvil) */}
      <div className="flex h-12 shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-surface px-3 sm:px-4">
        <div className="flex shrink-0 items-center gap-2.5">
          <IconButton className="md:hidden" aria-label={t('Nodos')} onClick={() => setPaletteOpen(true)}>
            <Menu size={16} />
          </IconButton>
          <div className="hidden h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary sm:flex">
            <Boxes size={16} />
          </div>
          <span className="hidden max-w-[160px] truncate text-sm font-medium text-txt-primary sm:inline">{workflowName}</span>
          {saveState !== 'idle' && (
            <span className="hidden text-[11px] text-txt-disabled sm:inline">{saveState === 'saving' ? t('Guardando…') : t('Guardado ✓')}</span>
          )}
          <Badge tone={STATUS_TONE[execStatus] ?? 'default'}>
            {running ? <Loader2 size={11} className="animate-spin" /> : <Dot tone={STATUS_TONE[execStatus] ?? 'default'} />} {t(statusLabel(execStatus))}
          </Badge>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <IconButton disabled={!canUndo} onClick={() => s().undo()} aria-label={t('Deshacer')}>
            <Undo2 size={16} />
          </IconButton>
          <IconButton disabled={!canRedo} onClick={() => s().redo()} aria-label={t('Rehacer')}>
            <Redo2 size={16} />
          </IconButton>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button size="sm" variant="subtle" onClick={autoLayout}>
            <LayoutGrid size={14} /> {t('Layout')}
          </Button>
          <Button size="sm" variant="subtle" onClick={() => s().addCommentAt({ x: 260, y: 120 })}>
            <StickyNote size={14} /> {t('Nota')}
          </Button>
          <Button size="sm" variant={aiChatOpen ? 'primary' : 'subtle'} onClick={() => setAiChatOpen((v) => !v)}>
            <Sparkles size={14} /> {t('IA')}
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button size="sm" variant={activated ? 'secondary' : 'primary'} onClick={handleActivate}>
            {activated ? <Check size={14} /> : <UploadCloud size={14} />} {activated ? t('Activo') : t('Activar')}
          </Button>
          <Button size="sm" variant="primary" onClick={handleRun}>
            <Play size={14} /> {t('Probar')}
          </Button>
        </div>
      </div>

      {/* Banner «falta configurar» (M26): resumen visible de los pasos por completar (estilo n8n). */}
      {setupIssues.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/25 bg-warning/10 px-4 py-1.5 text-[11px] text-warning">
          <TriangleAlert size={13} className="shrink-0" />
          <span>
            {setupIssues.length}{' '}
            {setupIssues.length === 1
              ? t('paso necesita configuración para funcionar. Está marcado con ⚠ en el lienzo.')
              : t('pasos necesitan configuración para funcionar. Están marcados con ⚠ en el lienzo.')}
          </span>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* Backdrop de la paleta en móvil */}
        {paletteOpen && <div className="absolute inset-0 z-20 bg-black/40 md:hidden" onClick={() => setPaletteOpen(false)} aria-hidden />}
        {/* Paleta — overlay deslizante en móvil, fija en desktop */}
        <aside
          className={cn(
            'absolute inset-y-0 left-0 z-30 w-44 shrink-0 overflow-y-auto border-r border-border bg-surface p-3 transition-transform duration-200',
            'md:relative md:z-0 md:translate-x-0',
            paletteOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">{t('Nodos')}</div>
            <IconButton className="md:hidden" aria-label={t('Cerrar')} onClick={() => setPaletteOpen(false)}>
              <X size={14} />
            </IconButton>
          </div>
          <div className="flex flex-col gap-1.5">
            {/* En producción se ocultan los bloques `advanced` (p. ej. HTTP crudo); en dev se ven todos. */}
            {listNodeTypes()
              .filter((nt) => import.meta.env.DEV || !nt.advanced)
              .map((nt) => {
              const Icon = nt.icon;
              return (
                <button
                  key={nt.kind}
                  onClick={() => {
                    addNode(nt.kind);
                    setPaletteOpen(false);
                  }}
                  className="group flex items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-left text-xs text-txt-primary transition-all hover:border-border-strong hover:bg-elevated"
                >
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-elevated transition-transform group-hover:scale-105 ${nt.color}`}>
                    <Icon size={14} strokeWidth={2} />
                  </span>
                  <span className="font-medium">{t(nt.label)}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-[10px] leading-relaxed text-txt-disabled">
            {t('Pulsa un bloque para añadirlo al flujo. Atajos: deshacer ⌘Z, copiar ⌘C/⌘V, borrar Supr.')}
          </p>
        </aside>

        {/* Canvas */}
        <div className="relative min-w-0 flex-1 bg-bg">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={(inst) => (rf.current = inst)}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(_, node) => {
              if (node.type === 'af') {
                s().setSelection([node.id], []);
                setInspectorOpen(true);
              }
            }}
            onPaneClick={() => s().setSelection([], [])}
            onConnect={onConnect}
            deleteKeyCode={null}
            selectionKeyCode="Shift"
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <SelectionSync />
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="rgb(var(--border))" />
            <MiniMap pannable zoomable nodeColor="rgb(var(--primary))" maskColor="rgb(var(--bg) / 0.6)" />
            <Controls />
          </ReactFlow>
          {lastError && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-border glass px-3 py-1.5 text-xs text-txt-primary shadow-pop">
              {lastError}
            </div>
          )}
        </div>

        {/* Inspector (minimizable) */}
        {inspectorOpen ? (
          <aside className="absolute inset-y-0 right-0 z-30 flex w-full max-w-xs flex-col border-l border-border bg-surface md:static md:z-0 md:w-80 md:max-w-none">
            <div className="flex items-center justify-between border-b border-border px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">
              <span>{t('Inspector')}</span>
              <IconButton aria-label={t('Ocultar inspector')} onClick={() => setInspectorOpen(false)}>
                <PanelRightClose size={15} />
              </IconButton>
            </div>
            <div className="flex-1 overflow-y-auto">
              <PropertiesPanel />
              <SubtaskTree />
            </div>
          </aside>
        ) : (
          <aside className="flex w-11 shrink-0 flex-col items-center border-l border-border bg-surface py-2">
            <IconButton aria-label={t('Mostrar inspector')} onClick={() => setInspectorOpen(true)}>
              <PanelRightOpen size={16} />
            </IconButton>
          </aside>
        )}

        {/* Chat de IA (M30): panel derecho para seguir modificando el flujo conversando. */}
        {aiChatOpen && <AiChatPanel onClose={() => setAiChatOpen(false)} />}
      </div>
    </div>
  );
}
