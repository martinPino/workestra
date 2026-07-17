import { create } from 'zustand';
import type { NodeType } from '@core/contracts';
import type { NodeRunStatus, PlanState } from '@core/domain';
import type { GraphDoc, EditorNode, EditorEdge, EditorComment } from './model';
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
  setCommentColor,
  setCommentSize,
  removeComment,
  replaceGraph as replaceGraphCmd,
  type Move,
} from './commands';
import { wouldCreateCycle } from './cycle';
import { defaultConfig } from './node-types';
import { useUI } from '../app/ui-store';
import { translate } from '../i18n';

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
  /** M66: mensaje de error por nodo (para el tooltip del sello ✗). */
  nodeErrors: Record<string, string>;
  plan?: PlanState;
  lastError: string | null;
  /** M78: id del agente a editar en una ventana (se abre al pulsar «Editar agente» en un nodo Agente). */
  editAgentId: string | null;

  canUndo: boolean;
  canRedo: boolean;

  loadDoc(doc: GraphDoc, meta: { id: string; name: string }): void;
  dispatchCmd(cmd: Command): void;
  /** Reemplaza nodos+aristas (edición de IA) conservando comentarios y de forma REVERSIBLE (⌘Z). */
  replaceGraph(nodes: EditorNode[], edges: EditorEdge[], comments?: EditorComment[]): void;
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
  setCommentColorById(id: string, color: string): void;
  /** Confirma el redimensionado de una nota (deshacible) con tamaño inicial/final explícitos (M64). */
  setCommentSizeById(id: string, from: { width?: number; height?: number }, to: { width: number; height: number }): void;
  /** Tamaño en vivo durante el arrastre de la esquina (NO deshacible; se confirma al soltar) — como setPositionsLive. */
  setCommentSizeLive(id: string, width: number, height: number): void;
  removeCommentById(id: string): void;
  applyLayout(positions: Record<string, { x: number; y: number }>): void;
  setError(msg: string | null): void;
  /** M78: abre/cierra la ventana de edición de un agente desde su nodo. */
  setEditAgentId(id: string | null): void;

  beginExec(): void;
  applyExec(status: string, nodeStatus: Record<string, NodeRunStatus>, nodeErrors: Record<string, string>, plan?: PlanState): void;
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
  nodeErrors: {},
  lastError: null,
  editAgentId: null,
  canUndo: false,
  canRedo: false,

  loadDoc: (doc, meta) =>
    set({ ...withFlags(createHistory(doc)), workflowId: meta.id, workflowName: meta.name, selection: [], selectedEdges: [] }),

  dispatchCmd: (cmd) => set(withFlags(busDispatch(get().history, cmd))),
  replaceGraph: (nodes, edges, comments) => get().dispatchCmd(replaceGraphCmd(get().history.doc, nodes, edges, comments)),
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
    // La selección puede incluir notas (M64): las notas se borran con su propio comando (viven en doc.comments).
    const commentIds = new Set(history.doc.comments.map((c) => c.id));
    const nodeSel = selection.filter((id) => !commentIds.has(id));
    const noteSel = selection.filter((id) => commentIds.has(id));
    if (nodeSel.length > 0) get().dispatchCmd(removeNodes(history.doc, nodeSel));
    for (const id of noteSel) get().dispatchCmd(removeComment(get().history.doc, id));
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
    // Plantilla tipo sticky (M60): 1ª línea = título, líneas con «- » = viñetas. El usuario la edita al vuelo.
    // El texto es contenido persistido, no UI: se traduce al crearlo, en el idioma activo.
    get().dispatchCmd(
      addComment({
        id: `c-${uid()}`,
        text: translate('Nueva nota\n- Escribe aquí un punto', useUI.getState().lang),
        position,
        color: 'amber',
      }),
    ),
  updateCommentText: (id, text) => get().dispatchCmd(updateComment(get().history.doc, id, text)),
  setCommentColorById: (id, color) => get().dispatchCmd(setCommentColor(get().history.doc, id, color)),
  setCommentSizeById: (id, from, to) => get().dispatchCmd(setCommentSize(id, from, to)),
  setCommentSizeLive: (id, width, height) =>
    set((s) => ({
      history: {
        ...s.history,
        doc: {
          ...s.history.doc,
          comments: s.history.doc.comments.map((c) => (c.id === id ? { ...c, width, height } : c)),
        },
      },
    })),
  removeCommentById: (id) => get().dispatchCmd(removeComment(get().history.doc, id)),

  applyLayout: (positions) => {
    const moves: Move[] = get()
      .history.doc.nodes.filter((n) => positions[n.id])
      .map((n) => ({ id: n.id, from: n.position, to: positions[n.id] }));
    get().commitMove(moves);
  },

  setError: (msg) => set({ lastError: msg }),
  setEditAgentId: (id) => set({ editAgentId: id }),

  beginExec: () => set({ execStatus: 'RUNNING', nodeStatus: {}, nodeErrors: {}, plan: undefined, lastError: null }),
  applyExec: (status, nodeStatus, nodeErrors, plan) => set({ execStatus: status, nodeStatus, nodeErrors, plan }),
  resetExec: () => set({ execStatus: 'idle', nodeStatus: {}, nodeErrors: {}, plan: undefined }),
}));
