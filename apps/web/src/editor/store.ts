import { create } from 'zustand';
import type { NodeType } from '@core/contracts';
import type { NodeRunStatus, PlanState } from '@core/domain';
import type { GraphDoc, EditorNode, EditorEdge } from './model';
import { emptyDoc } from './model';
import {
  type History,
  createHistory,
  dispatch as busDispatch,
  undo as busUndo,
  redo as busRedo,
  canUndo,
  canRedo,
} from './command-bus';
import {
  type Command,
  addNode,
  removeNodes,
  removeEdges,
  moveNodes,
  addEdge,
  updateNodeConfig,
  setNodeDisabled,
  pasteFragment,
  addComment,
  updateComment,
  removeComment,
  replaceGraph as replaceGraphCmd,
  type Move,
} from './commands';
import { wouldCreateCycle } from './cycle';
import { defaultConfig } from './node-types';

let counter = 0;
const uid = () => `${(++counter).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

interface EditorState {
  history: History;
  selection: string[];
  selectedEdges: string[];
  workflowId: string | null;
  workflowName: string;
  clipboard: { nodes: EditorNode[]; edges: EditorEdge[] } | null;
  execStatus: string;
  nodeStatus: Record<string, NodeRunStatus>;
  plan?: PlanState;
  lastError: string | null;

  canUndo: boolean;
  canRedo: boolean;

  loadDoc(doc: GraphDoc, meta: { id: string; name: string }): void;
  dispatchCmd(cmd: Command): void;
  /** Reemplaza nodos+aristas (edición de IA) conservando comentarios y de forma REVERSIBLE (⌘Z). */
  replaceGraph(nodes: EditorNode[], edges: EditorEdge[]): void;
  undo(): void;
  redo(): void;
  setSelection(nodes: string[], edges: string[]): void;
  addNodeOfKind(kind: NodeType | string, position: { x: number; y: number }): void;
  connect(source: string, target: string, sourceHandle?: string | null): boolean;
  removeSelected(): void;
  /** M38 (barra flotante del nodo): borrar / duplicar / activar-desactivar un paso concreto. */
  removeNodeById(id: string): void;
  duplicateNode(id: string): void;
  toggleNodeDisabled(id: string): void;
  setPositionsLive(moves: { id: string; position: { x: number; y: number } }[]): void;
  commitMove(moves: Move[]): void;
  updateConfig(id: string, config: Record<string, unknown>): void;
  copySelection(): void;
  paste(): void;
  addCommentAt(position: { x: number; y: number }): void;
  updateCommentText(id: string, text: string): void;
  removeCommentById(id: string): void;
  applyLayout(positions: Record<string, { x: number; y: number }>): void;
  setError(msg: string | null): void;

  beginExec(): void;
  applyExec(status: string, nodeStatus: Record<string, NodeRunStatus>, plan?: PlanState): void;
  resetExec(): void;
}

const withFlags = (history: History) => ({ history, canUndo: canUndo(history), canRedo: canRedo(history) });

export const useEditorStore = create<EditorState>((set, get) => ({
  history: createHistory(emptyDoc()),
  selection: [],
  selectedEdges: [],
  workflowId: null,
  workflowName: '…',
  clipboard: null,
  execStatus: 'idle',
  nodeStatus: {},
  lastError: null,
  canUndo: false,
  canRedo: false,

  loadDoc: (doc, meta) =>
    set({ ...withFlags(createHistory(doc)), workflowId: meta.id, workflowName: meta.name, selection: [], selectedEdges: [] }),

  dispatchCmd: (cmd) => set(withFlags(busDispatch(get().history, cmd))),
  replaceGraph: (nodes, edges) => get().dispatchCmd(replaceGraphCmd(get().history.doc, nodes, edges)),
  undo: () => set(withFlags(busUndo(get().history))),
  redo: () => set(withFlags(busRedo(get().history))),

  setSelection: (nodes, edges) => set({ selection: nodes, selectedEdges: edges }),

  addNodeOfKind: (kind, position) => {
    const id = `${kind}-${uid()}`;
    get().dispatchCmd(addNode({ id, kind: kind as NodeType, position, config: defaultConfig(kind) }));
    set({ selection: [id], selectedEdges: [] });
  },

  connect: (source, target, sourceHandle) => {
    const doc = get().history.doc;
    if (wouldCreateCycle(doc.edges, source, target)) {
      get().setError('No se puede conectar: el flujo debe avanzar en una sola dirección (sin bucles).');
      return false;
    }
    if (doc.edges.some((e) => e.source === source && e.target === target)) return false;
    get().dispatchCmd(addEdge({ id: `e-${uid()}`, source, target, sourceHandle: sourceHandle ?? null }));
    return true;
  },

  removeSelected: () => {
    const { history, selection, selectedEdges } = get();
    if (selection.length > 0) get().dispatchCmd(removeNodes(history.doc, selection));
    const doc2 = get().history.doc;
    const remaining = selectedEdges.filter((id) => doc2.edges.some((e) => e.id === id));
    if (remaining.length > 0) get().dispatchCmd(removeEdges(doc2, remaining));
    set({ selection: [], selectedEdges: [] });
  },

  // --- M38: acciones por-nodo de la barra flotante ---
  removeNodeById: (id) => {
    get().dispatchCmd(removeNodes(get().history.doc, [id]));
    set((s) => ({ selection: s.selection.filter((x) => x !== id) }));
  },
  duplicateNode: (id) => {
    const node = get().history.doc.nodes.find((n) => n.id === id);
    if (!node) return;
    const newId = `${node.kind}-${uid()}`;
    get().dispatchCmd(
      addNode({ ...node, id: newId, position: { x: node.position.x + 40, y: node.position.y + 40 }, config: { ...node.config } }),
    );
    set({ selection: [newId], selectedEdges: [] });
  },
  toggleNodeDisabled: (id) => {
    const node = get().history.doc.nodes.find((n) => n.id === id);
    if (!node) return;
    get().dispatchCmd(setNodeDisabled(get().history.doc, id, !node.disabled));
  },

  setPositionsLive: (moves) =>
    set((s) => ({
      history: {
        ...s.history,
        doc: {
          ...s.history.doc,
          nodes: s.history.doc.nodes.map((n) => {
            const m = moves.find((x) => x.id === n.id);
            return m ? { ...n, position: m.position } : n;
          }),
          comments: s.history.doc.comments.map((c) => {
            const m = moves.find((x) => x.id === c.id);
            return m ? { ...c, position: m.position } : c;
          }),
        },
      },
    })),

  commitMove: (moves) => {
    if (moves.length === 0) return;
    get().dispatchCmd(moveNodes(moves));
  },

  updateConfig: (id, config) => get().dispatchCmd(updateNodeConfig(get().history.doc, id, config)),

  copySelection: () => {
    const { history, selection } = get();
    const set2 = new Set(selection);
    const nodes = history.doc.nodes.filter((n) => set2.has(n.id));
    const edges = history.doc.edges.filter((e) => set2.has(e.source) && set2.has(e.target));
    set({ clipboard: nodes.length ? { nodes, edges } : get().clipboard });
  },

  paste: () => {
    const { clipboard } = get();
    if (!clipboard) return;
    const idmap = new Map<string, string>();
    const nodes = clipboard.nodes.map((n) => {
      const id = `${n.kind}-${uid()}`;
      idmap.set(n.id, id);
      return { ...n, id, position: { x: n.position.x + 48, y: n.position.y + 48 }, config: { ...n.config } };
    });
    const edges = clipboard.edges.map((e) => ({
      id: `e-${uid()}`,
      source: idmap.get(e.source)!,
      target: idmap.get(e.target)!,
      sourceHandle: e.sourceHandle ?? null,
    }));
    get().dispatchCmd(pasteFragment(nodes, edges));
    set({ selection: nodes.map((n) => n.id), selectedEdges: [] });
  },

  addCommentAt: (position) =>
    get().dispatchCmd(addComment({ id: `c-${uid()}`, text: 'Comentario…', position })),
  updateCommentText: (id, text) => get().dispatchCmd(updateComment(get().history.doc, id, text)),
  removeCommentById: (id) => get().dispatchCmd(removeComment(get().history.doc, id)),

  applyLayout: (positions) => {
    const moves: Move[] = get()
      .history.doc.nodes.filter((n) => positions[n.id])
      .map((n) => ({ id: n.id, from: n.position, to: positions[n.id] }));
    get().commitMove(moves);
  },

  setError: (msg) => set({ lastError: msg }),

  beginExec: () => set({ execStatus: 'RUNNING', nodeStatus: {}, plan: undefined, lastError: null }),
  applyExec: (status, nodeStatus, plan) => set({ execStatus: status, nodeStatus, plan }),
  resetExec: () => set({ execStatus: 'idle', nodeStatus: {}, plan: undefined }),
}));
