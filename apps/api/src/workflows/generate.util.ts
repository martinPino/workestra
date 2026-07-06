/**
 * Utilidades para «Construir con IA» (M29): generar un grafo de workflow a partir de una descripción en
 * lenguaje natural. Puro y testeable; la llamada al LLM y la validación (schema + DAG) viven en el servicio.
 */

/**
 * Extrae el PRIMER objeto JSON balanceado de la respuesta del LLM (tolera fences ```json y prosa alrededor).
 * Escanea contando llaves y respetando strings (para no romper con un `}` en la prosa que sigue al JSON, muy
 * común: `{...} Espero que esto {te sirva}`). null si no hay un objeto bien cerrado.
 */
export function extractJsonObject(text: string): string | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return body.slice(start, i + 1);
  }
  return null; // llaves sin cerrar
}

/** Conector/agente mínimos para poblar el catálogo del prompt (solo ids reales; nada de secretos). */
export interface GenConnector {
  id: string;
  provider: string;
  key: string;
}
export interface GenAgent {
  id: string;
  name: string;
}

/**
 * System prompt para el generador: describe el formato del grafo y el catálogo de tipos de nodo, más los
 * conectores/agentes REALES del workspace (para que use ids válidos y no invente). Devuelve texto plano.
 */
export function buildGeneratePrompt(connectors: GenConnector[], agents: GenAgent[]): string {
  const connLines = connectors.length
    ? connectors.map((c) => `  - ${c.id} → ${c.provider} («${c.key}»)`).join('\n')
    : '  (ninguno conectado)';
  const agentLines = agents.length ? agents.map((a) => `  - ${a.id} → ${a.name}`).join('\n') : '  (ninguno)';

  return [
    'Eres un generador de AUTOMATIZACIONES. A partir de la petición del usuario, devuelves SOLO un objeto JSON',
    '(sin texto alrededor, sin markdown) con esta forma EXACTA:',
    '{"name":"<nombre corto>","graph":{"nodes":[{"key":"id_unico","type":"<tipo>","config":{...},"position":{"x":<n>,"y":<n>}}],"edges":[{"source":"<key>","target":"<key>","sourceHandle":null}]}}',
    '',
    'Tipos de nodo y su config:',
    '- "trigger": {"event":"manual"|"webhook"|"cron"}  → SIEMPRE el primer nodo. Elige el evento según el usuario:',
    '    · "webhook" si la automatización debe ACTIVARSE cuando pasa algo en una app conectada (llega/se crea un',
    '      ticket, un correo, un mensaje…). Frases como «cuando…», «al crear…», «cada vez que llegue…» → "webhook".',
    '    · "cron" si es a una hora/periodicidad («cada mañana», «cada 5 min»).',
    '    · "manual" SOLO si el usuario la lanza a mano o no especifica cuándo.',
    '- "llm": {"model":"llama-3.3-70b-versatile","prompt":"<instrucción de sistema>","input":"<texto, admite {{variables}}>"}  → redactar/resumir/clasificar con IA.',
    '- "tool": {"message":"<texto a registrar>"}  → anotar/registrar.',
    '- "condition": {"expression":"campo == valor"}  → bifurca; sus aristas de salida usan sourceHandle "true" o "false".',
    '- "connector": {"connectorId":"<id de la lista>","method":"POST","path":"/ruta","body":"{...json...}"}  → enviar a una app conectada.',
    '- "agent": {"agentId":"<id de la lista>"}  → delegar en un asistente.',
    '- "end": {}  → SIEMPRE al menos un nodo final.',
    '',
    'Reglas OBLIGATORIAS:',
    '- Empieza en un "trigger" y acaba en "end". Es un DAG (sin ciclos); toda arista conecta nodos que existen.',
    '- keys únicas y descriptivas. Posiciones: x creciente (40, 260, 480, 700, 920…), y ≈ 200.',
    '- Para pasar datos entre nodos usa {{connector:KEY.json.campo}} o {{agent:KEY.output}} o {{llm no aplica}}: la salida de un nodo llm se lee con {{agent:KEY.output}}.',
    '- Usa "connector"/"agent" SOLO con ids REALES de las listas de abajo. Si no hay uno adecuado, resuélvelo con nodos "llm"/"tool" (NUNCA inventes ids).',
    '- El nombre y los textos, en español.',
    '',
    'Conectores disponibles (id → app):',
    connLines,
    '',
    'Asistentes disponibles (id → nombre):',
    agentLines,
  ].join('\n');
}
