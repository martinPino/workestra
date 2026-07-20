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
import { AnimatedEdge } from '../edges/AnimatedEdge';
import { PropertiesPanel } from '../components/PropertiesPanel';
import { AiChatPanel } from '../components/AiChatPanel';
import { AgentForm } from './Agents';
import { SubtaskTree } from '../components/SubtaskTree';
import { docToReactFlow, docToWorkflowGraph, workflowGraphToDoc, STARTER_DOC } from '../graph';
import { listNodeTypes } from '../editor/node-types';
import { HelpTip } from '../components/HelpTip';
import { graphSetupIssues } from '../editor/node-issues';
import { useEditorStore } from '../editor/store';
import { useAgents, useConnectors } from '../lib/hooks';
import { statusLabel } from '../lib/labels';
import { Button, IconButton, Badge, Dot } from '../ui';
import { TriangleAlert, Eye } from 'lucide-react';
import { useT } from '../i18n';
import { useCan } from '../lib/auth';
import { useAnalytics } from '../analytics/useAnalytics';

function SelectionSync() {
  useOnSelectionChange({
    onChange: ({ nodes, edges }) => {
      const st = useEditorStore.getState();
      // Incluye ids de notas (M64): si no, seleccionar una nota se descartaría aquí y sus asas de
      // redimensionado nunca aparecerían (las notas viven en doc.comments, no en doc.nodes).
      const ids = new Set([
        ...st.history.doc.nodes.map((n) => n.id),
        ...st.history.doc.comments.map((c) => c.id),
      ]);
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
  const nodeErrors = useEditorStore((s) => s.nodeErrors);
  const selection = useEditorStore((s) => s.selection);
  const execStatus = useEditorStore((s) => s.execStatus);
  const workflowId = useEditorStore((s) => s.workflowId);
  const workflowName = useEditorStore((s) => s.workflowName);
  const canUndo = useEditorStore((s) => s.canUndo);
  const canRedo = useEditorStore((s) => s.canRedo);
  const lastError = useEditorStore((s) => s.lastError);
  const s = useEditorStore.getState;
  const t = useT();
  const { trackEvent, trackError } = useAnalytics();
  // RBAC de UX (M74): un VIEWER (sin 'workflow:write') solo puede LEER el editor. La seguridad real la
  // impone el servidor; esto solo oculta/desactiva la edición para no ofrecer acciones que fallarían.
  const canEdit = useCan('workflow:write');
  const canRun = useCan('execution:create');

  const rf = useRef<ReactFlowInstance | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null); // contenedor del lienzo → centrar lo añadido en la vista (M62)
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
  const edgeTypes = useMemo(() => ({ animated: AnimatedEdge }), []); // arista con luz viajera (M65)
  const base = useMemo(() => docToReactFlow(doc, nodeStatus, true, nodeErrors), [doc, nodeStatus, nodeErrors]); // editable → barra flotante (M38)

  // «Falta configurar» (M26): pasos que aún no funcionarían (app sin conectar, asistente sin elegir…).
  // Se pintan como aviso en cada nodo (AfNode) y bloquean Probar/Activar con un mensaje claro.
  const agentsQuery = useAgents();
  const connectorsQuery = useConnectors();
  const agents = agentsQuery.data;
  const connectors = connectorsQuery.data;
  // M78: ventana de edición del AGENTE, abierta desde su nodo (botón «Editar agente» / doble clic).
  const editAgentId = useEditorStore((s) => s.editAgentId);
  const setEditAgentId = useEditorStore((s) => s.setEditAgentId);
  const editAgent = editAgentId ? agents?.find((a) => a.id === editAgentId) : undefined;
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
          if (list[0]) {
            const wf = await api.getWorkflow(list[0].id);
            s().loadDoc(wf.graph.nodes.length ? workflowGraphToDoc(wf.graph) : STARTER_DOC, { id: wf.id, name: wf.name });
          } else if (canEdit) {
            // Solo un rol con 'workflow:write' auto-crea el primer workflow; un VIEWER no debe crear.
            const wf = await api.createWorkflow('Mi primer workflow', docToWorkflowGraph(STARTER_DOC));
            s().loadDoc(wf.graph.nodes.length ? workflowGraphToDoc(wf.graph) : STARTER_DOC, { id: wf.id, name: wf.name });
          } else {
            s().loadDoc(STARTER_DOC, { id: 'local', name: t('Sin workflows') });
          }
        }
      } catch {
        s().setError(t('No se pudo conectar con la API'));
        s().loadDoc(STARTER_DOC, { id: 'local', name: t('local (sin API)') });
      }
    })();
  }, [id, canEdit]);

  // M84: apertura de la automatización. `useParams` puede venir sin id (ruta sin id: el editor abre la
  // primera que haya), así que se cae al id ya resuelto en el store. El ref evita el doble montaje de
  // StrictMode y, a la vez, deja pasar una apertura por automatización si se navega entre dos sin desmontar.
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    const wid = id ?? (workflowId && workflowId !== 'local' ? workflowId : undefined);
    if (!wid || openedRef.current === wid) return;
    openedRef.current = wid;
    trackEvent('workflow.opened', { entityType: 'workflow', entityId: wid });
  }, [id, workflowId, trackEvent]);

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
    // Incluye nodos Y notas (M60): así arrastrar una nota se registra como comando (deshacible).
    const d = s().history.doc;
    const ids = new Set([...d.nodes.map((n) => n.id), ...d.comments.map((c) => c.id)]);
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
    if (!canEdit) return undefined; // VIEWER de solo lectura: sin atajos que muten el grafo.
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
  }, [s, canEdit]);

  // Posición en coords del grafo del CENTRO de lo que se ve ahora (con jitter para no apilar). Antes se
  // añadía en una posición fija (260,120) que, con el lienzo desplazado, caía FUERA de la vista (M62).
  const centerPos = () => {
    const r = canvasRef.current?.getBoundingClientRect();
    const jitter = () => (Math.random() - 0.5) * 80;
    if (rf.current && r) {
      const p = rf.current.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      return { x: p.x + jitter(), y: p.y + jitter() };
    }
    return { x: 260 + jitter(), y: 160 + jitter() };
  };
  const addNode = (kind: string) => s().addNodeOfKind(kind, centerPos());
  const addNoteHere = () => {
    s().addCommentAt(centerPos());
    setPaletteOpen(false);
  };
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
        // M84: el autoguardado va con debounce (900 ms), así que esto cuenta SESIONES de edición, no
        // pulsaciones: una ráfaga de cambios seguidos emite un solo `workflow.updated`.
        trackEvent('workflow.updated', { entityType: 'workflow', entityId: workflowId });
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
      trackEvent('workflow.updated', { entityType: 'workflow', entityId: workflowId });
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
      let outcomeSent = false; // el desenlace se emite UNA vez: siguen llegando eventos hasta el unsub
      const unsub = subscribeExecution(api.base, executionId, (e) => {
        buffer.push(e);
        const state = reduceExecution(buffer);
        const map: Record<string, NodeRunStatus> = {};
        const errs: Record<string, string> = {};
        for (const [k, v] of Object.entries(state.nodes)) {
          map[k] = v.status;
          if (v.error) errs[k] = v.error;
        }
        s().applyExec(state.status, map, errs, state.plan);
        if (state.status === 'SUCCEEDED' || state.status === 'FAILED') {
          // M84: el desenlace se emite AQUÍ y no en `api.execute`, porque ese POST solo encola (devuelve
          // QUEUED/RUNNING): darlo por bueno al aceptarlo dejaría la tasa de fallo clavada a cero.
          if (outcomeSent) return;
          outcomeSent = true;
          if (state.status === 'SUCCEEDED') {
            trackEvent('workflow.run.succeeded', {
              entityType: 'workflow',
              entityId: workflowId,
              props: { nodeCount: Object.keys(state.nodes).length },
            });
          } else {
            trackEvent('workflow.run.failed', { entityType: 'workflow', entityId: workflowId });
            // Una ejecución fallida SE VE: el lienzo pinta el nodo en rojo y el panel muestra el fallo.
            // Por eso cuenta también como error mostrado — si no, el panel de errores solo conocería los
            // fallos de red y daría a entender que el producto solo falla al llamar a la API.
            //
            // El código es la constante 'run-failed' y no se deriva de `state` ni de `errs`: el mensaje de
            // error de un nodo trae dentro el valor que lo hizo reventar (un prompt, una fila de datos del
            // cliente), y en el momento en que eso se usa para construir un código, el código deja de ser
            // un código y pasa a ser el dato. Para el detalle está la ejecución, que ya se guarda entera.
            trackError({ kind: 'workflow', code: 'run-failed' });
          }
          setTimeout(unsub, 400);
        }
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
          {canEdit && (
            <IconButton className="md:hidden" aria-label={t('Nodos')} onClick={() => setPaletteOpen(true)}>
              <Menu size={16} />
            </IconButton>
          )}
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
          {!canEdit && (
            <Badge tone="default">
              <Eye size={11} /> {t('Solo lectura')}
            </Badge>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Barra de edición: solo con 'workflow:write'. Un VIEWER no ve deshacer/rehacer, layout, nota,
              IA (edita el flujo) ni activar/publicar; conserva la lectura del lienzo. */}
          {canEdit && (
            <>
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
              <Button size="sm" variant="subtle" onClick={addNoteHere}>
                <StickyNote size={14} /> {t('Nota')}
              </Button>
              <Button
                size="sm"
                variant={aiChatOpen ? 'primary' : 'subtle'}
                onClick={() => {
                  const next = !aiChatOpen;
                  setAiChatOpen(next);
                  if (next) setInspectorOpen(false); // panel derecho único: evita el solape (sobre todo en móvil)
                }}
              >
                <Sparkles size={14} /> {t('IA')}
              </Button>
              <div className="mx-1 h-4 w-px bg-border" />
              <Button size="sm" variant={activated ? 'secondary' : 'primary'} onClick={handleActivate} data-track="workflow-publish">
                {activated ? <Check size={14} /> : <UploadCloud size={14} />} {activated ? t('Activo') : t('Activar')}
              </Button>
            </>
          )}
          {canRun && (
            <Button size="sm" variant="primary" onClick={handleRun} data-track="workflow-run">
              <Play size={14} /> {t('Probar')}
            </Button>
          )}
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
        {canEdit && paletteOpen && <div className="absolute inset-0 z-20 bg-black/40 md:hidden" onClick={() => setPaletteOpen(false)} aria-hidden />}
        {/* Paleta (añadir nodos/notas) — solo con 'workflow:write'; un VIEWER no la ve. */}
        {canEdit && (
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
            {/* «Nota» (M62): NO es un paso del flujo — es una nota adhesiva de color en el lienzo. Va aquí,
                donde el usuario busca bloques, y crea la sticky (no el nodo de registro, que confundía). */}
            <button
              onClick={addNoteHere}
              className="group flex items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-left text-xs text-txt-primary transition-all hover:border-border-strong hover:bg-elevated"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-elevated text-amber-400 transition-transform group-hover:scale-105">
                <StickyNote size={14} strokeWidth={2} />
              </span>
              <span className="font-medium">{t('Nota')}</span>
              <HelpTip text={t('Una nota adhesiva de color para anotar en el lienzo (no se ejecuta).')} />
            </button>
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
                  {nt.help && <HelpTip text={t(nt.help)} />}
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-[10px] leading-relaxed text-txt-disabled">
            {t('Pulsa un bloque para añadirlo al flujo. Atajos: deshacer ⌘Z, copiar ⌘C/⌘V, borrar Supr.')}
          </p>
        </aside>
        )}

        {/* Canvas */}
        <div ref={canvasRef} className="relative min-w-0 flex-1 bg-bg">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={(inst) => (rf.current = inst)}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(_, node) => {
              if (node.type === 'af') {
                s().setSelection([node.id], []);
                setInspectorOpen(true);
                setAiChatOpen(false); // panel derecho único
              } else if (node.type === 'comment') {
                s().setSelection([node.id], []); // seleccionar la nota → muestra sus asas de redimensionado (M64)
              }
            }}
            onPaneClick={() => s().setSelection([], [])}
            onConnect={onConnect}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            elementsSelectable={canEdit}
            deleteKeyCode={canEdit ? undefined : null} // VIEWER: sin borrar por teclado; editores conservan Backspace
            selectionKeyCode="Shift"
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <SelectionSync />
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="rgb(var(--border))" />
            {/* Minimapa subido (M67) para dejar sitio a la burbuja flotante del chat en la esquina. */}
            <MiniMap pannable zoomable nodeColor="rgb(var(--primary))" maskColor="rgb(var(--bg) / 0.6)" style={{ bottom: 84 }} />
            <Controls />
          </ReactFlow>
          {lastError && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-border glass px-3 py-1.5 text-xs text-txt-primary shadow-pop">
              {lastError}
            </div>
          )}
          {/* Burbuja flotante del chat de IA (M67): lanzador en la esquina inferior derecha, además del
              botón «IA» de la barra. Se oculta mientras el panel está abierto (el propio panel lo cierra). */}
          {canEdit && !aiChatOpen && (
            <button
              type="button"
              onClick={() => {
                setAiChatOpen(true);
                setInspectorOpen(false); // panel derecho único: evita el solape
              }}
              aria-label={t('Abrir asistente de IA')}
              title={t('Asistente de IA')}
              className="group absolute bottom-4 right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full brand-gradient text-white shadow-pop ring-1 ring-white/15 transition-transform hover:scale-105 active:scale-95"
            >
              <Sparkles size={22} className="transition-transform duration-200 group-hover:rotate-12" />
            </button>
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
            <IconButton
              aria-label={t('Mostrar inspector')}
              onClick={() => {
                setInspectorOpen(true);
                setAiChatOpen(false);
              }}
            >
              <PanelRightOpen size={16} />
            </IconButton>
          </aside>
        )}

        {/* Chat de IA (M30): panel derecho para seguir modificando el flujo conversando. Solo con edición. */}
        {canEdit && aiChatOpen && <AiChatPanel onClose={() => setAiChatOpen(false)} />}
      </div>

      {/* M78: ventana de edición del AGENTE (rol, objetivo, modelo, herramientas), abierta desde su nodo.
          Reutiliza el mismo formulario que la página Asistentes; al guardar refresca los agentes → el nodo se actualiza. */}
      {editAgentId && (
        <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto p-4 sm:p-8" role="dialog" aria-modal="true">
          <button type="button" aria-label={t('Cerrar')} className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setEditAgentId(null)} />
          <div className="relative z-10 w-full max-w-2xl">
            {editAgent ? (
              <AgentForm key={editAgent.id} initial={editAgent} onDone={() => setEditAgentId(null)} onCancel={() => setEditAgentId(null)} />
            ) : (
              <div className="rounded-2xl border border-border bg-elevated p-8 text-center text-sm text-txt-secondary shadow-pop">
                {agentsQuery.isLoading ? t('Cargando…') : t('Este agente ya no existe.')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
