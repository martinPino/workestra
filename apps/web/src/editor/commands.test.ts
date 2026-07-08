import { describe, it, expect } from 'vitest';
import type { GraphDoc, EditorNode } from './model';
import { normalizeDoc } from './model';
import {
  type Command,
  addNode,
  removeNodes,
  moveNodes,
  addEdge,
  removeEdges,
  updateNodeConfig,
  pasteFragment,
  addComment,
  updateComment,
  removeComment,
  setCommentSize,
  replaceGraph,
} from './commands';
import { createHistory, dispatch, undo, redo } from './command-bus';

// RNG determinista (mulberry32) para property tests reproducibles.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genDoc(r: () => number): GraphDoc {
  const n = 2 + Math.floor(r() * 5);
  const nodes: EditorNode[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    kind: 'tool',
    position: { x: Math.floor(r() * 500), y: Math.floor(r() * 500) },
    config: { v: Math.floor(r() * 10) },
  }));
  const edges = [];
  for (let i = 0; i < n - 1; i++) {
    if (r() > 0.4) edges.push({ id: `e${i}`, source: `n${i}`, target: `n${i + 1}` });
  }
  const comments =
    r() > 0.5 ? [{ id: 'c0', text: 'nota', position: { x: 10, y: 10 } }] : [];
  return { nodes, edges, comments };
}

function genCommand(r: () => number, doc: GraphDoc): Command {
  const nodeIds = doc.nodes.map((n) => n.id);
  const edgeIds = doc.edges.map((e) => e.id);
  const pick = <T>(arr: T[]): T => arr[Math.floor(r() * arr.length)];
  const ops = [
    () => addNode({ id: `new${Math.floor(r() * 1e6)}`, kind: 'agent', position: { x: r() * 100, y: r() * 100 }, config: {} }),
    () => (nodeIds.length ? removeNodes(doc, [pick(nodeIds)]) : addNode({ id: `x${Math.floor(r() * 1e6)}`, kind: 'end', position: { x: 0, y: 0 }, config: {} })),
    () =>
      moveNodes(
        nodeIds.filter(() => r() > 0.5).map((id) => {
          const from = doc.nodes.find((n) => n.id === id)!.position;
          return { id, from, to: { x: r() * 900, y: r() * 900 } };
        }),
      ),
    () => addEdge({ id: `ne${Math.floor(r() * 1e6)}`, source: pick(nodeIds), target: pick(nodeIds) }),
    () => (edgeIds.length ? removeEdges(doc, [pick(edgeIds)]) : addComment({ id: `cm${Math.floor(r() * 1e6)}`, text: 't', position: { x: 0, y: 0 } })),
    () => (nodeIds.length ? updateNodeConfig(doc, pick(nodeIds), { v: Math.floor(r() * 100), extra: 'z' }) : addNode({ id: `y${Math.floor(r() * 1e6)}`, kind: 'tool', position: { x: 0, y: 0 }, config: {} })),
    () =>
      pasteFragment(
        [{ id: `p${Math.floor(r() * 1e6)}`, kind: 'llm', position: { x: 5, y: 5 }, config: {} }],
        [],
      ),
    () => addComment({ id: `cm${Math.floor(r() * 1e6)}`, text: 'hola', position: { x: r() * 50, y: r() * 50 } }),
    () => (doc.comments.length ? updateComment(doc, pick(doc.comments.map((c) => c.id)), 'editado') : addComment({ id: `cm${Math.floor(r() * 1e6)}`, text: 'x', position: { x: 0, y: 0 } })),
    () => (doc.comments.length ? removeComment(doc, pick(doc.comments.map((c) => c.id))) : addComment({ id: `cm${Math.floor(r() * 1e6)}`, text: 'x', position: { x: 0, y: 0 } })),
    () => {
      if (!doc.comments.length) return addComment({ id: `cm${Math.floor(r() * 1e6)}`, text: 'x', position: { x: 0, y: 0 } });
      const cm = pick(doc.comments);
      return setCommentSize(cm.id, { width: cm.width, height: cm.height }, { width: 180 + Math.floor(r() * 200), height: 100 + Math.floor(r() * 200) });
    },
  ];
  return pick(ops)();
}

describe('CommandBus — apply∘invert = identidad', () => {
  it('undo(redo(doc)) ≡ doc para 400 comandos aleatorios', () => {
    const r = rng(12345);
    for (let i = 0; i < 400; i++) {
      const doc = genDoc(r);
      const cmd = genCommand(r, doc);
      const back = cmd.undo(cmd.redo(doc));
      expect(normalizeDoc(back)).toEqual(normalizeDoc(doc));
    }
  });

  it('replaceGraph (edición de IA) conserva las notas y es reversible', () => {
    const doc: GraphDoc = {
      nodes: [{ id: 'a', kind: 'trigger', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
      comments: [{ id: 'c0', text: 'mi nota', position: { x: 5, y: 5 } }],
    };
    const newNodes: EditorNode[] = [
      { id: 'a', kind: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'b', kind: 'end', position: { x: 200, y: 0 }, config: {} },
    ];
    const newEdges = [{ id: 'e', source: 'a', target: 'b', sourceHandle: null }];
    const cmd = replaceGraph(doc, newNodes, newEdges);
    const after = cmd.redo(doc);
    expect(after.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(after.edges).toEqual(newEdges);
    expect(after.comments).toEqual(doc.comments); // NO borra las notas del usuario
    expect(normalizeDoc(cmd.undo(after))).toEqual(normalizeDoc(doc)); // reversible con ⌘Z
  });

  it('una secuencia de comandos se deshace por completo hasta el estado inicial', () => {
    const r = rng(999);
    const start = genDoc(r);
    let h = createHistory(start);
    for (let i = 0; i < 20; i++) h = dispatch(h, genCommand(r, h.doc));
    const advanced = h.doc;
    while (h.past.length > 0) h = undo(h);
    expect(normalizeDoc(h.doc)).toEqual(normalizeDoc(start));
    while (h.future.length > 0) h = redo(h);
    expect(normalizeDoc(h.doc)).toEqual(normalizeDoc(advanced));
  });
});
