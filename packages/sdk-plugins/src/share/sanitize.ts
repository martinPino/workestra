import type {
  Agent,
  PortableAgent,
  PortableWorkflowDoc,
  ShareReport,
  ShareRedactionItem,
  ShareStripItem,
  WorkflowGraph,
} from '@core/contracts';
import { SHARE_DOC_VERSION } from '@core/contracts';

/**
 * Sanitizador para compartir un workflow (M85). Convierte un workflow VIVO en una forma portable y SIN
 * secretos. Es el núcleo de seguridad de la feature: un secreto que se escape acaba en un enlace público.
 *
 * Dos reglas que aguantan el paso del tiempo:
 *
 * 1. ALLOWLIST, nunca denylist. La config de un nodo es un `record` abierto y creciente; con una lista de
 *    lo PROHIBIDO, cada campo nuevo que alguien añada mañana viaja por defecto. Con una lista de lo
 *    PERMITIDO, lo desconocido se cae —y perder un campo útil se nota y se arregla; dejar salir un secreto
 *    no—. Por eso: lo que no está en la tabla de abajo, fuera.
 * 2. La estructura se quita por CLAVE (determinista); el contenido de los textos que sí viajan (prompts,
 *    cuerpos) se pasa por un escáner de FORMA de credencial. Son dos capas ortogonales.
 */

/** Función pura y determinista: no muta la entrada. La API le pasa los agentes y conectores ya resueltos. */
export interface SanitizeInput {
  workflow: { name: string; graph: WorkflowGraph };
  /** Registro completo de cada agente referenciado por el grafo (por `getInWorkspace`). */
  agents: Agent[];
}

/**
 * Claves de config que se CONSERVAN por tipo de nodo. Lo que no esté aquí se descarta. Las referencias
 * (agentId, connectorId) y los ids de cuenta se tratan aparte, abajo.
 */
const SAFE_CONFIG_KEYS: Record<string, string[]> = {
  // Comunes a varios: el motor/editor los usan como estructura, no llevan secretos.
  trigger: ['event', 'eventId'], // `folderId` y `connectorId` se QUITAN (son de la cuenta)
  agent: ['input'], //  agentId → agentRef
  llm: ['prompt', 'model', 'input', 'noRepetir'],
  router: ['model', 'input', 'max'], // agentId → agentRef
  condition: ['expression'],
  loop: ['over', 'as', 'max'],
  wait: ['ms'],
  human: ['reason', 'ttlMs'],
  api: ['method', 'url', 'body'], // `headers` se QUITA (suele llevar la clave)
  download: ['url'], // `headers` se QUITA
  extract: ['fileId', 'lang'],
  code: ['code'],
  memory: ['scope', 'key'],
  connector: ['action', 'method'], // provider derivado; connectorId, path, body, actionParams → placeholders
  tool: ['message'],
  end: [],
};

/** Campos de config que SÍ pueden llevar texto pegado por una persona → pasan por el escáner de credenciales. */
const SCANNED_KEYS = new Set(['prompt', 'input', 'body', 'code', 'message', 'reason', 'expression']);

/**
 * Formas de credencial de ALTA confianza: se redactan en el sitio y se cuentan. Una etiqueta describe qué
 * era; el valor nunca viaja. El orden importa poco: se aplican todas.
 */
const HIGH_CONFIDENCE: Array<{ re: RegExp; label: string }> = [
  { re: /\baf_[A-Za-z0-9_-]{16,}/g, label: 'clave de Workestra' },
  { re: /\bsk-(ant-)?[A-Za-z0-9_-]{16,}/g, label: 'clave de OpenAI/Anthropic' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: 'token de Slack' },
  { re: /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g, label: 'token de GitHub' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'clave de AWS' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: 'clave de Google' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, label: 'JWT' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, label: 'clave privada' },
  { re: /(?:https?:)?\/\/[^/\s:@]+:[^/\s:@]+@/g, label: 'usuario:clave en una URL' },
  { re: /\b(?:authorization|bearer)\s*[:=]?\s*["']?[A-Za-z0-9._-]{20,}/gi, label: 'cabecera de autorización' },
];

/**
 * Forma de BAJA confianza: un blob largo sin espacios y sin ser una referencia `{{…}}`. Bloquea, no redacta.
 * SIN la bandera `/g` A PROPÓSITO: con `.test()`, un regex global arrastra `lastIndex` entre llamadas y da
 * true/false/true sobre el MISMO texto. En el flujo real la vista previa y la creación son dos llamadas
 * seguidas: con estado, la creación podía NO detectar lo que la vista previa sí marcó, y el blob acababa en
 * el enlace público sin bloquear. Sin `/g`, `.test()` es puro.
 */
const LOW_CONFIDENCE = /\b(?=[A-Za-z0-9+/=_-]*[A-Za-z])(?=[A-Za-z0-9+/=_-]*[0-9])[A-Za-z0-9+/=_-]{32,}\b/;

const REDACTED = '«SECRETO_REDACTADO»';

/** Sustituye los `{{…}}` por un hueco antes de escanear: son referencias, no secretos, y matan falsos positivos. */
function maskRefs(s: string): string {
  return s.replace(/\{\{[^}]*\}\}/g, ' ');
}

interface ScanResult {
  text: string;
  redactions: Array<{ label: string }>;
  blocking: Array<{ label: string }>;
}

/** Escanea (y redacta lo de alta confianza) un texto que va a viajar. */
function scan(text: string): ScanResult {
  const redactions: Array<{ label: string }> = [];
  let out = text;
  for (const { re, label } of HIGH_CONFIDENCE) {
    // `replace` con `/g` empieza SIEMPRE desde cero (no arrastra `lastIndex` como haría un `.test()`), así
    // que se reemplaza y se mira si cambió, en vez de `test`+`replace` —que solo funciona por accidente,
    // porque el `replace` resetea el estado que el `test` dejó—.
    const replaced = out.replace(re, REDACTED);
    if (replaced !== out) {
      redactions.push({ label });
      out = replaced;
    }
  }
  // Baja confianza: se mira sobre el texto con las referencias enmascaradas y ya redactado lo de alta.
  const blocking: Array<{ label: string }> = [];
  const masked = maskRefs(out).split(REDACTED).join(' ');
  if (LOW_CONFIDENCE.test(masked)) blocking.push({ label: 'texto que parece una credencial' });
  return { text: out, redactions, blocking };
}

interface DeepScanResult {
  value: unknown;
  redactions: Array<{ label: string }>;
  blocking: Array<{ label: string }>;
}

/**
 * Escaneo EN PROFUNDIDAD. El escáner de arriba solo mira strings, pero la config de un nodo es
 * `record(unknown)`: el `body` de un nodo api suele ser un OBJETO JSON, y el motor lo acepta
 * (`JSON.stringify(raw)`). Si no se recorre, un token pegado dentro de ese objeto —`{ auth: 'Bearer af_…' }`—
 * viajaría intacto al enlace público (el mismo valor que SÍ se redacta como string). Se redacta cada hoja de
 * texto; números/booleanos/null no llevan secretos y se dejan igual. Determinista, no muta la entrada.
 */
function scanDeep(val: unknown): DeepScanResult {
  if (typeof val === 'string') {
    const r = scan(val);
    return { value: r.text, redactions: r.redactions, blocking: r.blocking };
  }
  if (Array.isArray(val)) {
    const redactions: Array<{ label: string }> = [];
    const blocking: Array<{ label: string }> = [];
    const value = val.map((v) => {
      const r = scanDeep(v);
      redactions.push(...r.redactions);
      blocking.push(...r.blocking);
      return r.value;
    });
    return { value, redactions, blocking };
  }
  if (val && typeof val === 'object') {
    const redactions: Array<{ label: string }> = [];
    const blocking: Array<{ label: string }> = [];
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const r = scanDeep(v);
      redactions.push(...r.redactions);
      blocking.push(...r.blocking);
      value[k] = r.value;
    }
    return { value, redactions, blocking };
  }
  return { value: val, redactions: [], blocking: [] };
}

/** ¿La cadena es SOLO una referencia `{{…}}`? Entonces un id literal no se coló; se deja pasar. */
function isPureRef(s: string): boolean {
  return /^\s*\{\{[^}]*\}\}\s*$/.test(s.trim());
}

/**
 * Escanea un campo de texto suelto que va a viajar (nombre del flujo, nombre/rol del agente, url) y anota lo
 * redactado/bloqueante en los acumuladores del informe. Son campos que una persona teclea: aunque «no
 * deberían» llevar secretos, pegar una clave en un título es exactamente el descuido que esto ataja.
 */
function scanField(
  text: string,
  location: string,
  contentRedactions: ShareRedactionItem[],
  blocking: ShareRedactionItem[],
): string {
  const r = scan(text);
  for (const red of r.redactions) contentRedactions.push({ location, pattern: red.label, action: 'redact' });
  for (const b of r.blocking) blocking.push({ location, pattern: b.label, action: 'needs_review' });
  return r.text;
}

export function sanitizeWorkflowForShare(input: SanitizeInput): { doc: PortableWorkflowDoc; report: ShareReport } {
  const structuralStrip: ShareStripItem[] = [];
  const contentRedactions: ShareRedactionItem[] = [];
  const blocking: ShareRedactionItem[] = [];
  let promptChars = 0;

  // 1) Agentes referenciados → orden determinista → ref estable. Se cubren agentId a nivel nodo Y en config.
  const referenced = new Set<string>();
  for (const n of input.workflow.graph.nodes) {
    const cfg = (n.config ?? {}) as Record<string, unknown>;
    if (typeof n.agentId === 'string') referenced.add(n.agentId);
    if (typeof cfg.agentId === 'string') referenced.add(cfg.agentId);
  }
  const refById = new Map<string, string>();
  [...referenced].sort().forEach((id, i) => refById.set(id, `agent_${i}`));

  // 2) Nodos: solo las claves permitidas; referencias e ids de cuenta → marcadores.
  const nodes = input.workflow.graph.nodes.map((n) => {
    const allow = SAFE_CONFIG_KEYS[n.type] ?? [];
    const src = (n.config ?? {}) as Record<string, unknown>;
    const config: Record<string, unknown> = {};

    for (const key of allow) {
      if (!(key in src)) continue;
      let val = src[key];
      // El fichero de `extract` debe ser una referencia; un id literal apuntaría a un fichero de otra cuenta.
      if (n.type === 'extract' && key === 'fileId' && typeof val === 'string' && !isPureRef(val)) {
        structuralStrip.push({ kind: 'accountId', node: n.key });
        continue;
      }
      // La URL de api/download: se quita la query (suele llevar la clave) y el usuario:clave, y ADEMÁS se
      // escanea lo que queda: un secreto puede vivir en el PATH (p.ej. el token de un bot de Telegram,
      // `/bot<id>:<secreto>/…`), que `cleanUrl` conserva. Sin escanear, ese path viajaría intacto.
      if ((n.type === 'api' || n.type === 'download') && key === 'url' && typeof val === 'string') {
        const cleaned = cleanUrl(val);
        if (cleaned.stripped) structuralStrip.push({ kind: 'urlKey', node: n.key });
        val = scanField(cleaned.url, `${n.key}.url`, contentRedactions, blocking);
      } else if (SCANNED_KEYS.has(key)) {
        // `scanDeep` mira también objetos/arrays: un `body` JSON es lo normal en un nodo api, y ahí es
        // donde más fácil se cuela una credencial pegada.
        if (key === 'prompt' || key === 'input') promptChars += typeof val === 'string' ? val.length : JSON.stringify(val).length;
        const r = scanDeep(val);
        val = r.value;
        for (const red of r.redactions) contentRedactions.push({ location: `${n.key}.${key}`, pattern: red.label, action: 'redact' });
        for (const b of r.blocking) blocking.push({ location: `${n.key}.${key}`, pattern: b.label, action: 'needs_review' });
      }
      config[key] = val;
    }

    // Referencia a agente → agentRef (marcador que el importador resuelve a un agente recién creado).
    const agentId = (typeof n.agentId === 'string' && n.agentId) || (typeof src.agentId === 'string' && src.agentId) || '';
    if (agentId && refById.has(agentId)) config.agentRef = refById.get(agentId);

    // Nodo conector: el provider (comparable entre cuentas) en vez del connectorId (cuid del espacio).
    if (n.type === 'connector') {
      structuralStrip.push({ kind: 'connectorId', node: n.key });
      const prov = pickProvider(src, input.agents);
      if (prov) config.provider = prov;
    }
    // Cabeceras y carpeta: fuera, siempre. Se anotan para que el importador sepa qué reponer.
    if ((n.type === 'api' || n.type === 'download') && 'headers' in src) structuralStrip.push({ kind: 'header', node: n.key });
    if (n.type === 'trigger' && 'folderId' in src) structuralStrip.push({ kind: 'folderId', node: n.key });

    return { key: n.key, type: n.type, config, position: n.position, ...(n.disabled ? { disabled: true } : {}) };
  });

  // 3) Agentes → forma portable, con el prompt escaneado y la URL de MCP fuera.
  const agents: PortableAgent[] = [...referenced]
    .sort()
    .map((id) => input.agents.find((a) => a.id === id))
    .filter((a): a is Agent => !!a)
    .map((a) => {
      promptChars += a.systemPrompt.length;
      const r = scan(a.systemPrompt);
      const ref = refById.get(a.id)!;
      for (const red of r.redactions) contentRedactions.push({ location: `${ref}.prompt`, pattern: red.label, action: 'redact' });
      for (const b of r.blocking) blocking.push({ location: `${ref}.prompt`, pattern: b.label, action: 'needs_review' });
      const mcp = (a.mcpServers ?? []).map((s) => {
        structuralStrip.push({ kind: 'mcpServer', agent: ref });
        return { name: s.name }; // la URL se queda fuera: puede llevar la clave embebida
      });
      return {
        ref,
        // Nombre y rol también se escanean: son texto libre que viaja y se enseña en la preview pública.
        name: scanField(a.name, `${ref}.name`, contentRedactions, blocking),
        role: a.description ? scanField(a.description, `${ref}.role`, contentRedactions, blocking) : undefined,
        systemPrompt: r.text,
        model: a.model,
        tools: a.tools ?? [],
        ...(mcp.length ? { mcpServers: mcp } : {}),
        ...(a.isOrchestrator ? { isOrchestrator: true } : {}),
      };
    });

  // El nombre del flujo también se escanea (se muestra en la preview pública). OJO al orden: se escanea
  // ANTES de construir el informe, porque `redactionCount` y `canCreate` son instantáneas (número/booleano)
  // de los acumuladores; un secreto en el nombre debe contar y, si es de baja confianza, BLOQUEAR.
  const safeName = scanField(input.workflow.name, 'workflow.name', contentRedactions, blocking);

  const redactionCount = contentRedactions.length;
  const report: ShareReport = {
    willShare: { nodeCount: nodes.length, agentCount: agents.length, promptChars },
    structuralStrip,
    contentRedactions,
    blocking,
    redactionCount,
    canCreate: blocking.length === 0,
  };

  const doc: PortableWorkflowDoc = {
    version: SHARE_DOC_VERSION,
    name: safeName,
    graph: { nodes, edges: input.workflow.graph.edges } as WorkflowGraph,
    agents,
  };
  return { doc, report };
}

/** Quita de una URL el usuario:clave y la query entera; devuelve origen+ruta. */
function cleanUrl(raw: string): { url: string; stripped: boolean } {
  try {
    const u = new URL(raw);
    const hadSecret = !!(u.username || u.password || u.search);
    u.username = '';
    u.password = '';
    u.search = '';
    return { url: u.toString(), stripped: hadSecret };
  } catch {
    // No era una URL absoluta (o llevaba `{{…}}`): se deja tal cual, pero si tiene `?` se marca.
    return { url: raw.split('?')[0], stripped: raw.includes('?') };
  }
}

/** Deduce el provider de un nodo conector: de la config, o del conector referenciado si lo tuviéramos. */
function pickProvider(cfg: Record<string, unknown>, _agents: Agent[]): string | undefined {
  if (typeof cfg.provider === 'string') return cfg.provider;
  return undefined; // sin provider, el importador mostrará «elige tu conector»
}
