import type { WorkflowGraph } from '@core/contracts';
import { topologicalLevels, validateDag } from '@core/domain';

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Estructura del grafo → texto legible + diagrama mermaid, para «explicar gráficamente» un flujo. */
export function explainGraph(graph: WorkflowGraph): string {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (nodes.length === 0) return 'El flujo está vacío (sin nodos).';

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const lines: string[] = [`Flujo con ${nodes.length} nodos y ${edges.length} conexiones.`];

  const levels = topologicalLevels(graph);
  if (!levels) {
    lines.push('⚠ El grafo tiene un ciclo (no es un DAG válido).');
  } else {
    lines.push('', 'Orden de ejecución (por niveles; los del mismo nivel corren en paralelo):');
    levels.forEach((lvl, i) => {
      const desc = lvl.map((k) => `${k} (${byKey.get(k)?.type ?? '?'})`).join(', ');
      lines.push(`  Nivel ${i + 1}: ${desc}`);
    });
  }

  const mermaid = ['flowchart TD'];
  for (const n of nodes) mermaid.push(`  ${sanitize(n.key)}["${n.key}: ${n.type}"]`);
  for (const e of edges) {
    const label = e.sourceHandle ? `|${e.sourceHandle}|` : '';
    mermaid.push(`  ${sanitize(e.source)} -->${label} ${sanitize(e.target)}`);
  }
  lines.push('', 'Diagrama (mermaid):', '```mermaid', ...mermaid, '```');
  return lines.join('\n');
}

/** Hallazgos estáticos de un grafo: nodos inalcanzables, callejones sin salida, falta de inicio/fin, ciclos. */
export function staticFindings(graph: WorkflowGraph): string[] {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const findings: string[] = [];
  const types = new Set(nodes.map((n) => n.type));
  if (!types.has('trigger')) findings.push('No hay nodo de inicio (trigger).');
  if (!types.has('end')) findings.push('No hay nodo final (end).');

  const hasIncoming = new Set(edges.map((e) => e.target));
  const hasOutgoing = new Set(edges.map((e) => e.source));
  for (const n of nodes) {
    if (n.type !== 'trigger' && !hasIncoming.has(n.key)) findings.push(`El nodo «${n.key}» (${n.type}) no tiene entradas: es inalcanzable.`);
    if (n.type !== 'end' && !hasOutgoing.has(n.key)) findings.push(`El nodo «${n.key}» (${n.type}) no tiene salida: es un callejón sin salida.`);
  }

  const dag = validateDag(graph);
  if (!dag.valid) findings.push('El grafo no es un DAG válido: ' + dag.errors.join('; '));
  if (findings.length === 0) findings.push('Sin problemas estructurales detectados.');
  return findings;
}

/** Firma estructural del grafo (para detectar duplicados): tipos de nodo ordenados + nº de aristas. */
export function structuralSignature(graph: WorkflowGraph): string {
  const types = (graph.nodes ?? []).map((n) => n.type).sort();
  return `${types.join(',')}|edges=${(graph.edges ?? []).length}`;
}
