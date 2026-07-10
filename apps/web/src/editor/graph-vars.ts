import type { NodeType } from '@core/contracts';
import type { GraphDoc, EditorNode } from './model';

/**
 * Variables disponibles para un nodo (M56): qué DATOS de pasos anteriores puede insertar el usuario en un
 * campo `{{...}}`, y validación de referencias inexistentes. Un nodo solo «ve» las salidas de sus ANCESTROS
 * (los nodos aguas arriba), que es exactamente lo que hay en el contexto cuando ese nodo se ejecuta. Puro
 * (sin React) → testeable. Los prefijos (`agent:`, `text:`, `file:`…) son los que escriben los executors.
 */
export interface VarSuggestion {
  /** Referencia sin llaves, p. ej. `agent:llm.output`. */
  ref: string;
  /** Etiqueta humana, p. ej. «Salida de la IA». */
  label: string;
  /** Nodo que la produce (para agrupar/mostrar). */
  nodeId: string;
  kind: NodeType;
}

/** Referencias de salida que EXPONE un nodo, según su tipo. Vacío para nodos sin salida útil aguas abajo. */
export function outputsForNode(n: EditorNode): VarSuggestion[] {
  const k = n.id; // en el editor, id del nodo === key de runtime
  const mk = (ref: string, label: string): VarSuggestion => ({ ref, label, nodeId: n.id, kind: n.kind });
  switch (n.kind) {
    case 'agent':
    case 'llm':
      return [mk(`agent:${k}.output`, 'Salida de la IA')];
    case 'connector':
      return [mk(`connector:${k}.json`, 'Respuesta de la app (datos)'), mk(`connector:${k}.bodyPreview`, 'Respuesta de la app (texto)')];
    case 'download':
      return [mk(`file:${k}.id`, 'Fichero descargado'), mk(`file:${k}.text`, 'Contenido del fichero (texto)')];
    case 'extract':
      return [mk(`text:${k}.text`, 'Texto extraído')];
    case 'code':
      return [mk(`code:${k}.output`, 'Datos transformados')];
    case 'api':
      return [mk(`http:${k}.json`, 'Respuesta HTTP (datos)'), mk(`http:${k}.status`, 'Código de estado HTTP')];
    default:
      return []; // trigger, condition, router, wait, human, end… no exponen datos reutilizables por campo
  }
}

/** Ancestros (nodos aguas arriba alcanzables) de `nodeId`, MÁS CERCANOS primero (BFS inverso). */
export function ancestorIds(doc: GraphDoc, nodeId: string): string[] {
  const incoming = new Map<string, string[]>();
  for (const e of doc.edges) {
    const arr = incoming.get(e.target);
    if (arr) arr.push(e.source);
    else incoming.set(e.target, [e.source]);
  }
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [...(incoming.get(nodeId) ?? [])];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const p of incoming.get(id) ?? []) if (!seen.has(p)) queue.push(p);
  }
  return order;
}

/** Variables que SIEMPRE provee el disparador (según su tipo). Se ofrecen aunque no haya ancestros. */
export const TRIGGER_VARS: VarSuggestion[] = [
  { ref: 'file:trigger.id', label: 'Fichero del disparador (Google Drive)', nodeId: 'trigger', kind: 'trigger' },
  { ref: 'ticket.summary', label: 'Asunto del evento (webhook/Jira)', nodeId: 'trigger', kind: 'trigger' },
  { ref: 'ticket.description', label: 'Descripción del evento (webhook/Jira)', nodeId: 'trigger', kind: 'trigger' },
  { ref: 'ticket.key', label: 'Clave del ticket (Jira)', nodeId: 'trigger', kind: 'trigger' },
  // Disparador de Sentry (M80): el webhook `issue.created` inyecta `issue` en el contexto.
  { ref: 'issue.title', label: 'Título del issue (Sentry)', nodeId: 'trigger', kind: 'trigger' },
  { ref: 'issue.level', label: 'Nivel del issue (Sentry)', nodeId: 'trigger', kind: 'trigger' },
  { ref: 'issue.culprit', label: 'Causa probable del issue (Sentry)', nodeId: 'trigger', kind: 'trigger' },
  { ref: 'issue.permalink', label: 'Enlace al issue (Sentry)', nodeId: 'trigger', kind: 'trigger' },
  { ref: 'issue.shortId', label: 'ID corto del issue (Sentry)', nodeId: 'trigger', kind: 'trigger' },
  { ref: 'issue.id', label: 'ID del issue (Sentry)', nodeId: 'trigger', kind: 'trigger' },
];

/** Sugerencias para el nodo `nodeId`: salidas de sus ancestros (cercanos primero) + del disparador. */
export function availableVars(doc: GraphDoc, nodeId: string): VarSuggestion[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out: VarSuggestion[] = [];
  for (const id of ancestorIds(doc, nodeId)) {
    const n = byId.get(id);
    if (n) out.push(...outputsForNode(n));
  }
  out.push(...TRIGGER_VARS);
  return out;
}

// Raíces que el motor/disparador siempre puede proveer: no las marcamos como desconocidas (evita falsos positivos).
const BASE_ROOTS = ['ticket', 'repository', 'variables', 'file:trigger', 'driveFile', 'trigger', 'payload', 'issueKey', 'scheduleId', 'webhook', 'issue'];

/**
 * Devuelve las referencias `{{...}}` de `text` que NO coinciden con ninguna variable disponible — el caso
 * que rompía el envío a Slack (`{{agent:summary.output}}` cuando el nodo era `llm`). Coincide por raíz
 * (`agent:llm` valida `agent:llm.output`) para tolerar navegar a subcampos.
 */
export function unknownRefs(text: string, vars: VarSuggestion[]): string[] {
  const roots = new Set<string>(BASE_ROOTS);
  for (const v of vars) {
    roots.add(v.ref.replace(/\.[^.]*$/, '')); // «agent:llm.output» → raíz «agent:llm»
    roots.add(v.ref);
  }
  const rootList = [...roots];
  const bad: string[] = [];
  const re = /\{\{([^}]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tok = m[1].trim();
    const ok = rootList.some((r) => tok === r || tok.startsWith(r + '.'));
    if (!ok && !bad.includes(tok)) bad.push(tok);
  }
  return bad;
}
