import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
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
import { Undo2, Redo2, LayoutGrid, StickyNote, Play, Save, Boxes, Loader2, UploadCloud, PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { ExecutionEvent } from '@core/contracts';
import { reduceExecution, type NodeRunStatus } from '@core/domain';
import { api } from '../lib/api';
import { subscribeExecution } from '../lib/socket';
import { computeLayout } from '../lib/layout';
import { AfNode } from '../nodes/AfNode';
import { CommentNode } from '../nodes/CommentNode';
import { PropertiesPanel } from '../components/PropertiesPanel';
import { SubtaskTree } from '../components/SubtaskTree';
import { docToReactFlow, docToWorkflowGraph, workflowGraphToDoc, STARTER_DOC } from '../graph';
import { listNodeTypes } from '../editor/node-types';
import { useEditorStore } from '../editor/store';
import { Button, IconButton, Badge, Dot } from '../ui';

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

  const rf = useRef<ReactFlowInstance | null>(null);
  const dragStart = useRef<Record<string, { x: number; y: number }>>({});
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const nodeTypes = useMemo(() => ({ af: AfNode, comment: CommentNode }), []);
  const base = useMemo(() => docToReactFlow(doc, nodeStatus), [doc, nodeStatus]);
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
        s().setError('No se pudo conectar con la API');
        s().loadDoc(STARTER_DOC, { id: 'local', name: 'local (sin API)' });
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

  const handleSave = async () => {
    if (!workflowId || workflowId === 'local') return;
    try {
      await api.saveGraph(workflowId, docToWorkflowGraph(s().history.doc));
      s().setError('Guardado ✓');
    } catch {
      s().setError('Error al guardar (¿ciclo?)');
    }
  };

  const handlePublish = async () => {
    if (!workflowId || workflowId === 'local') return;
    try {
      await api.saveGraph(workflowId, docToWorkflowGraph(s().history.doc));
      const v = await api.publish(workflowId);
      setPublishedVersion(v.version);
      s().setError(`Publicada v${v.version} ✓ — las ejecuciones se anclan a esta versión`);
    } catch {
      s().setError('Error al publicar');
    }
  };

  const handleRun = async () => {
    if (!workflowId || workflowId === 'local') return;
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
      s().setError('Error al ejecutar');
    }
  };

  const running = execStatus === 'RUNNING';

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Boxes size={16} />
          </div>
          <span className="text-sm font-medium text-txt-primary">{workflowName}</span>
          {publishedVersion != null && <Badge tone="primary">v{publishedVersion}</Badge>}
          <Badge tone={STATUS_TONE[execStatus] ?? 'default'}>
            {running ? <Loader2 size={11} className="animate-spin" /> : <Dot tone={STATUS_TONE[execStatus] ?? 'default'} />} {execStatus}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <IconButton disabled={!canUndo} onClick={() => s().undo()} aria-label="Deshacer">
            <Undo2 size={16} />
          </IconButton>
          <IconButton disabled={!canRedo} onClick={() => s().redo()} aria-label="Rehacer">
            <Redo2 size={16} />
          </IconButton>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button size="sm" variant="subtle" onClick={autoLayout}>
            <LayoutGrid size={14} /> Layout
          </Button>
          <Button size="sm" variant="subtle" onClick={() => s().addCommentAt({ x: 260, y: 120 })}>
            <StickyNote size={14} /> Nota
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button size="sm" variant="secondary" onClick={handleSave}>
            <Save size={14} /> Guardar
          </Button>
          <Button size="sm" variant="secondary" onClick={handlePublish}>
            <UploadCloud size={14} /> Publicar
          </Button>
          <Button size="sm" variant="primary" onClick={handleRun}>
            <Play size={14} /> Ejecutar
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Paleta */}
        <aside className="w-44 shrink-0 border-r border-border bg-surface p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">Nodos</div>
          <div className="flex flex-col gap-1.5">
            {listNodeTypes().map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.kind}
                  onClick={() => addNode(t.kind)}
                  className="group flex items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-left text-xs text-txt-primary transition-all hover:border-border-strong hover:bg-elevated"
                >
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-elevated transition-transform group-hover:scale-105 ${t.color}`}>
                    <Icon size={14} strokeWidth={2} />
                  </span>
                  <span className="font-medium">{t.label}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-[10px] leading-relaxed text-txt-disabled">
            La paleta se genera desde el registro. Atajos: ⌘Z, ⌘C/⌘V, Supr.
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
          <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-txt-disabled">
              <span>Inspector</span>
              <IconButton aria-label="Ocultar inspector" onClick={() => setInspectorOpen(false)}>
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
            <IconButton aria-label="Mostrar inspector" onClick={() => setInspectorOpen(true)}>
              <PanelRightOpen size={16} />
            </IconButton>
          </aside>
        )}
      </div>
    </div>
  );
}
