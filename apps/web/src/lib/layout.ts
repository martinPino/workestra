import dagre from '@dagrejs/dagre';
import type { GraphDoc } from '../editor/model';

/** Auto-layout con dagre (izquierda→derecha). Devuelve el mapa de posiciones por nodo. */
export function computeLayout(doc: GraphDoc): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90, marginx: 40, marginy: 40 });

  const W = 150;
  const H = 52;
  for (const n of doc.nodes) g.setNode(n.id, { width: W, height: H });
  for (const e of doc.edges) if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of doc.nodes) {
    const pos = g.node(n.id);
    if (pos) positions[n.id] = { x: Math.round(pos.x - W / 2), y: Math.round(pos.y - H / 2) };
  }
  return positions;
}
