import { Injectable, Inject, NotFoundException, BadRequestException } from '../http/common';
import { type Role, type McpServerRef, McpServerRefSchema, AgentDraftSchema, type AgentDraft, type MemoryScope } from '@core/contracts';
import { createLlmRouter } from '@core/llm';
import { McpHttpClient } from '@core/infra';
import { z } from 'zod';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { LlmKeysService } from '../llm-keys/llm-keys.service';
import { extractJsonObject, isRateLimitError } from '../workflows/generate.util';
import { buildAssistantPreamble } from '../workflows/assistant-context';

// Catálogos válidos para el borrador de la IA (M68): claves de herramientas y modelos ofrecibles a un agente.
// Se saneará contra estas listas; deben coincidir con la UI (lib/tools.ts y pages/agent-roles.ts).
const AGENT_TOOL_KEYS = ['http', 'mock', 'browser'];
const AGENT_MODEL_KEYS = [
  'mock-1',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3.2',
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-opus-4-8',
  'gpt-5',
];

interface CreateAgentBody {
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  mcpServers?: McpServerRef[];
  memoryScope?: MemoryScope | string | null;
  limits?: Record<string, unknown>;
  permissions?: { role?: Role };
  isOrchestrator?: boolean;
}

const MEMORY_SCOPES = ['temporal', 'persistent', 'shared'] as const;

/**
 * Valida la memoria del agente (M81): enum cerrado, o `null` para apagarla. Se RECHAZA un valor inventado en
 * vez de normalizarlo a null: el runtime falla cerrado ante lo desconocido, así que un typo dejaría al agente
 * sin memoria mientras la UI la sigue pintando encendida. Mejor un 400 que una mentira silenciosa.
 */
function normalizeMemoryScope(raw: unknown): MemoryScope | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = z.enum(MEMORY_SCOPES).safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException(`memoryScope inválido: ${String(raw)}. Usa ${MEMORY_SCOPES.join(' | ')}, o null para apagarla.`);
  }
  return parsed.data;
}

/** Valida y normaliza los servidores MCP (M40): URL válida obligatoria; asegura un id estable por servidor. */
function normalizeMcpServers(raw: unknown): McpServerRef[] {
  const parsed = z.array(McpServerRefSchema.partial({ id: true })).safeParse(raw ?? []);
  if (!parsed.success) throw new BadRequestException('Servidor MCP inválido: revisa el nombre y la URL (http/https).');
  return parsed.data.map((s, i) => ({ id: s.id?.trim() || `mcp_${Date.now().toString(36)}_${i}`, name: s.name, url: s.url }));
}

@Injectable()
export class AgentsService {
  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    private readonly llmKeys: LlmKeysService,
  ) {}

  list(workspaceId: string) {
    return this.p.agents.list(workspaceId);
  }

  async get(id: string, workspaceId: string) {
    const agent = await this.p.agents.getInWorkspace(id, workspaceId); // solo si es del tenant
    if (!agent) throw new NotFoundException(`Agente no encontrado: ${id}`);
    return agent;
  }

  create(body: CreateAgentBody, workspaceId: string) {
    return this.p.agents.create({
      workspaceId,
      name: body.name,
      description: body.description ?? null,
      systemPrompt: body.systemPrompt ?? 'Eres un asistente útil.',
      model: body.model ?? 'mock-1',
      tools: body.tools ?? [],
      mcpServers: body.mcpServers ? normalizeMcpServers(body.mcpServers) : null,
      // M81: la memoria es OPT-IN. Antes se sembraba 'shared' por defecto (y el runtime lo ignoraba); ahora
      // 'shared' significa memoria de EQUIPO, así que por defecto va apagada y se enciende desde la UI.
      memoryScope: normalizeMemoryScope(body.memoryScope),
      variables: null,
      limits: body.limits ?? null,
      permissions: body.permissions ?? { role: 'EDITOR' },
      isOrchestrator: body.isOrchestrator ?? false,
    });
  }

  /** Actualiza solo los campos presentes en `body` (tenant-safe: 404 si no es del workspace). */
  async update(id: string, body: Partial<CreateAgentBody>, workspaceId: string) {
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description ?? null;
    if (body.systemPrompt !== undefined) patch.systemPrompt = body.systemPrompt;
    if (body.model !== undefined) patch.model = body.model;
    if (body.tools !== undefined) patch.tools = body.tools;
    if (body.mcpServers !== undefined) patch.mcpServers = normalizeMcpServers(body.mcpServers);
    if (body.memoryScope !== undefined) patch.memoryScope = normalizeMemoryScope(body.memoryScope);
    if (body.limits !== undefined) patch.limits = body.limits;
    if (body.permissions !== undefined) patch.permissions = body.permissions;
    if (body.isOrchestrator !== undefined) patch.isOrchestrator = body.isOrchestrator;
    const updated = await this.p.agents.update(id, workspaceId, patch);
    if (!updated) throw new NotFoundException(`Agente no encontrado: ${id}`);
    return updated;
  }

  async remove(id: string, workspaceId: string) {
    const ok = await this.p.agents.delete(id, workspaceId);
    if (!ok) throw new NotFoundException(`Agente no encontrado: ${id}`);
    return { deleted: true };
  }

  /**
   * Prueba la conexión con un servidor MCP (M43/M45): initialize + tools/list. Si el servidor está CONECTADO
   * (hay una credencial guardada para él), la envía como `Authorization: Bearer`. Devuelve si está OK (con nº
   * de tools) o si falla, distinguiendo «faltan credenciales» (401/403) de «no responde». La UI muestra el aviso.
   */
  async verifyMcp(
    url: string,
    workspaceId?: string,
    serverId?: string,
  ): Promise<{ ok: boolean; tools?: number; needsAuth?: boolean; connected?: boolean; reason?: string }> {
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('URL inválida (usa http/https).');
    const token = workspaceId && serverId ? await this.p.secrets.get(workspaceId, `mcp:auth:${serverId}`).catch(() => undefined) : undefined;
    try {
      const client = new McpHttpClient(url, token ? { Authorization: `Bearer ${token}` } : {});
      await client.initialize();
      const tools = await client.listTools();
      return { ok: true, tools: tools.length, connected: !!token };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const needsAuth = /\b(401|403)\b|unauthor|forbidden|not authenticated/i.test(msg);
      return { ok: false, needsAuth, connected: !!token, reason: msg.slice(0, 200) };
    }
  }

  /** «Conectar» un servidor MCP (M45): guarda su credencial CIFRADA (secret store) por workspace+servidor. */
  async connectMcp(workspaceId: string, serverId: string, token: string): Promise<{ connected: boolean }> {
    if (!serverId?.trim() || !token?.trim()) throw new BadRequestException('Falta el servidor o la credencial.');
    await this.p.secrets.set(workspaceId, `mcp:auth:${serverId}`, token.trim());
    return { connected: true };
  }

  /** «Desconectar»: borra la credencial guardada del servidor. */
  async disconnectMcp(workspaceId: string, serverId: string): Promise<{ connected: boolean }> {
    await this.p.secrets.delete(workspaceId, `mcp:auth:${serverId}`);
    return { connected: false };
  }

  // --- «Crear asistente con IA» (M68) --------------------------------------------------------------
  // Router LLM con las claves BYOK del workspace o las de plataforma (M35). Duplicado a propósito del de
  // WorkflowsService: helper diminuto, aislado; evita acoplar dos servicios y reduce riesgo de regresión.
  private async buildRouter(workspaceId: string) {
    const byok = await this.llmKeys.resolve(workspaceId);
    return createLlmRouter({
      openaiApiKey: byok.openai,
      anthropicApiKey: byok.anthropic,
      openrouterApiKey: byok.openrouter,
      llmApiKey: byok.groq,
    });
  }

  private tokenLimit(): number {
    return Math.max(0, Number(process.env.WORKSPACE_TOKEN_LIMIT ?? 0) || 0);
  }

  private cleanPrompt(prompt: string): string {
    const clean = (prompt ?? '').trim();
    if (!clean) throw new BadRequestException('Describe el asistente que quieres crear.');
    if (clean.length > 2000) throw new BadRequestException('La descripción es demasiado larga (máx. 2000 caracteres).');
    return clean;
  }

  /**
   * Chat de la página Asistentes: la persona describe en lenguaje natural el asistente que quiere y la IA
   * devuelve un BORRADOR (rol, objetivo, instrucciones, modelo, herramientas, si coordina) que la UI usa
   * para rellenar el formulario (la persona revisa y pulsa «Crear»), o una respuesta de texto si solo pregunta.
   * Mismo patrón que WorkflowsService.chatGraph: preámbulo + JSON único + validación Zod con 1 reintento.
   */
  async chatDraft(
    message: string,
    workspaceId: string,
    opts: { model?: string } = {},
  ): Promise<{ kind: 'create'; agent: AgentDraft } | { kind: 'answer'; text: string }> {
    const clean = this.cleanPrompt(message);

    const limit = this.tokenLimit();
    if (limit > 0 && (await this.p.usage.todayTokens(workspaceId)) >= limit) {
      throw new BadRequestException('Has alcanzado el límite diario de IA de tu espacio de trabajo. Inténtalo de nuevo mañana o sube el límite.');
    }
    const llm = await this.buildRouter(workspaceId);
    const chosen = opts.model?.trim() || process.env.LLM_MODEL || 'llama-3.3-70b-versatile';

    const system = [
      buildAssistantPreamble('agents'),
      '',
      'MODO CREAR ASISTENTE: la persona quiere crear un «asistente» (un especialista de IA con su rol, objetivo,',
      'instrucciones, modelo y herramientas). Conversa con ella y decide. Responde SIEMPRE con UN ÚNICO objeto JSON,',
      'sin texto alrededor ni ```:',
      '- Si describe (aunque sea brevemente) el asistente que quiere: {"kind":"create","agent":{"name":"<rol corto, p. ej. Investigador>","description":"<el objetivo en una frase>","systemPrompt":"<instrucciones de sistema claras y accionables, 2-5 frases, escritas en 2ª persona («Eres un…»)>","model":"<uno de los modelos válidos>","tools":[<0 o más claves de herramienta válidas>],"isOrchestrator":<true SOLO si su función es planificar y delegar en otros asistentes; si no, false>}}.',
      '- Si solo pregunta o pide una aclaración (no describe un asistente): {"kind":"answer","text":"<respuesta breve, en el MISMO idioma de la persona>"}.',
      '',
      'MODELOS válidos para "model" (por defecto «llama-3.3-70b-versatile», que es gratis; elige el más adecuado):',
      `  ${AGENT_MODEL_KEYS.filter((m) => m !== 'mock-1').join(', ')}.`,
      'HERRAMIENTAS válidas para "tools" (usa SOLO estas claves, o [] si no necesita ninguna):',
      '  "http" (Petición web: llamar a una API por HTTP), "mock" (Eco de prueba, para probar).',
      'No inventes otras herramientas ni modelos. Redacta todo (rol, objetivo, instrucciones) en el idioma de la persona.',
    ].join('\n');
    const user = ['Mensaje de la persona:', clean].join('\n');

    const base = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ];
    let lastErr = 'sin respuesta';
    let rateLimited = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages =
        attempt === 0
          ? base
          : [...base, { role: 'user' as const, content: `Tu respuesta anterior no fue válida (${lastErr}). Devuelve SOLO el objeto JSON con "kind":"create" o "kind":"answer".` }];
      let res;
      try {
        res = await llm.chat({ model: chosen, messages, responseFormat: 'json', maxTokens: 900 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isRateLimitError(msg)) rateLimited = true;
        lastErr = `error del modelo: ${msg}`;
        break;
      }
      const used = (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0);
      if (used > 0) await this.p.usage.add(workspaceId, used).catch(() => undefined);
      const jsonStr = extractJsonObject(res.content ?? '');
      if (!jsonStr) {
        lastErr = 'no se encontró JSON en la respuesta';
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        lastErr = 'JSON mal formado';
        continue;
      }
      const o = (parsed ?? {}) as { kind?: string; text?: string; answer?: string; agent?: unknown; name?: unknown; systemPrompt?: unknown };
      // Es respuesta de texto solo si NO parece un borrador (mismo criterio que chatGraph con graph/nodes):
      // así un borrador SIN el envoltorio `agent` que traiga un `text` suelto no se confunde con una respuesta.
      const looksLikeDraft = o.agent !== undefined || o.name !== undefined || o.systemPrompt !== undefined;
      const isAnswer = o.kind === 'answer' || (!looksLikeDraft && (typeof o.text === 'string' || typeof o.answer === 'string'));
      if (isAnswer) {
        const text = String(o.text ?? o.answer ?? '').trim();
        if (text) return { kind: 'answer', text: text.slice(0, 4000) };
        lastErr = 'respuesta de texto vacía';
        continue;
      }
      const draft = AgentDraftSchema.safeParse(o.agent ?? parsed);
      if (!draft.success) {
        lastErr = `estructura inválida: ${JSON.stringify(draft.error.issues.slice(0, 2))}`;
        continue;
      }
      // Sanea contra los catálogos reales: herramientas solo del catálogo; modelo dentro de la lista.
      const agent: AgentDraft = {
        ...draft.data,
        tools: (draft.data.tools ?? []).filter((tk) => AGENT_TOOL_KEYS.includes(tk)),
        model: AGENT_MODEL_KEYS.includes(draft.data.model) ? draft.data.model : 'llama-3.3-70b-versatile',
      };
      return { kind: 'create', agent };
    }
    if (rateLimited) {
      throw new BadRequestException(
        'La IA ha alcanzado su límite de uso por ahora. Inténtalo de nuevo en unos minutos, o conecta otro proveedor de IA (sube el plan de Groq o añade una clave de OpenAI).',
      );
    }
    throw new BadRequestException(`La IA no pudo diseñar el asistente. ${lastErr}`);
  }
}
