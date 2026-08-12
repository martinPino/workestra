import { Injectable, Inject, BadRequestException } from '../http/common';
import { WorkflowGraphSchema, type WorkflowGraph } from '@core/contracts';
import { validateDag } from '@core/domain';
import { createLlmRouter } from '@core/llm';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { assertInWorkspace } from '../tenant/tenant.util';
import { TriggersService } from '../triggers/triggers.service';
import { SchedulesService } from '../schedules/schedules.service';
import { extractJsonObject, buildGeneratePrompt, isRateLimitError } from './generate.util';
import { buildAssistantPreamble } from './assistant-context';
import { LlmKeysService } from '../llm-keys/llm-keys.service';

@Injectable()
export class WorkflowsService {
  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    private readonly triggers: TriggersService,
    private readonly schedules: SchedulesService,
    private readonly llmKeys: LlmKeysService,
  ) {}

  /**
   * Construye el router LLM para un workspace (M35 BYOK): si el workspace aportó sus propias claves, se usan
   * ESAS (sobrescriben la config de plataforma); si no, `createLlmRouter` cae a las variables de entorno.
   */
  private async buildRouter(workspaceId: string) {
    const byok = await this.llmKeys.resolve(workspaceId);
    return createLlmRouter({
      openaiApiKey: byok.openai,
      anthropicApiKey: byok.anthropic,
      openrouterApiKey: byok.openrouter,
      llmApiKey: byok.groq, // Groq/openai-compatible; undefined → LLM_API_KEY de plataforma
    });
  }

  /** Carga un workflow verificando que pertenece al workspace autenticado (404 si no). */
  private async getOwned(id: string, workspaceId: string) {
    const wf = await this.p.workflows.get(id);
    assertInWorkspace(wf?.workspaceId, workspaceId, 'Workflow');
    return wf!;
  }

  create(input: { name: string; graph?: unknown }, workspaceId: string) {
    const graph = input.graph !== undefined ? this.parseGraph(input.graph) : undefined;
    return this.p.workflows.create({ workspaceId, name: input.name, graph });
  }

  list(workspaceId: string) {
    return this.p.workflows.list(workspaceId);
  }

  get(id: string, workspaceId: string) {
    return this.getOwned(id, workspaceId);
  }

  async saveGraph(id: string, graph: unknown, workspaceId: string) {
    await this.getOwned(id, workspaceId);
    const parsed = this.parseGraph(graph);
    // El compiler DAG rechaza ciclos/aristas colgantes antes de persistir (criterio M1).
    const validation = validateDag(parsed);
    if (!validation.valid) {
      throw new BadRequestException({ message: 'Grafo inválido (no es un DAG)', errors: validation.errors });
    }
    return this.p.workflows.saveGraph(id, parsed);
  }

  /** Congela el draft en una versión inmutable `published` (M4p). */
  async publish(id: string, workspaceId: string) {
    await this.getOwned(id, workspaceId);
    const version = await this.p.workflows.publish(id);
    // M53: el nodo Trigger es la FUENTE ÚNICA DE VERDAD. Al publicar reconciliamos el sondeo de Google Drive
    // desde el grafo congelado (crea/actualiza/borra el ScheduledTrigger que el worker sondea). Es best-effort
    // y NUNCA lanza, así que publicar sigue funcionando aunque no haya cola (dev) o falle la reconciliación.
    await this.schedules.reconcileFromGraph(id, workspaceId, version.graph);
    return version;
  }

  async listVersions(id: string, workspaceId: string) {
    await this.getOwned(id, workspaceId);
    return this.p.workflows.listVersions(id);
  }

  /**
   * Borra el workflow SOLO si es del workspace (deny-by-default por tenant, 404 si no). Captura sus
   * disparadores ANTES para, tras el borrado (que los elimina en cascada), desregistrar en Jira los
   * webhooks huérfanos (best-effort, no bloquea el borrado).
   */
  async remove(id: string, workspaceId: string) {
    await this.getOwned(id, workspaceId);
    const bindings = await this.triggers.listByWorkflow(id, workspaceId);
    await this.p.workflows.delete(id);
    await this.triggers.reconcileAfterWorkflowDelete(bindings, workspaceId);
    return { deleted: true };
  }

  /**
   * «Construir con IA» (M29): genera un grafo de workflow desde una descripción en lenguaje natural. Pide al
   * LLM un JSON con el catálogo de nodos + los conectores/agentes REALES del workspace, y VALIDA (schema + DAG).
   */
  async generate(prompt: string, workspaceId: string, model?: string): Promise<{ name: string; graph: WorkflowGraph }> {
    const clean = this.cleanPrompt(prompt);
    return this.runLlmGraph(await this.catalogPrompt(workspaceId), clean, workspaceId, model);
  }

  /**
   * «Chat con IA en el editor» (M30): modifica el grafo ACTUAL según una instrucción en lenguaje natural
   * («añade un Slack al final», «cambia el trigger a cada mañana»). Le pasa el grafo actual + el catálogo y
   * exige el flujo COMPLETO modificado; valida schema + DAG igual que `generate`.
   */
  async editGraph(graph: unknown, prompt: string, workspaceId: string, model?: string): Promise<{ name: string; graph: WorkflowGraph }> {
    const clean = this.cleanPrompt(prompt);
    const current = this.parseGraph(graph); // valida que el grafo de entrada esté bien formado
    const user = [
      'Flujo ACTUAL (JSON):',
      JSON.stringify({ nodes: current.nodes, edges: current.edges }),
      '',
      'Aplica este cambio y DEVUELVE EL FLUJO COMPLETO modificado (todos los nodos que deben quedar, con sus posiciones y configs; no solo el cambio):',
      clean,
    ].join('\n');
    return this.runLlmGraph(await this.catalogPrompt(workspaceId), user, workspaceId, model);
  }

  /**
   * «Chat consciente del contexto en el editor» (M36). A diferencia de `editGraph` (que SIEMPRE reescribe el
   * grafo), aquí el usuario está VIENDO un flujo en el lienzo y conversa: puede pedir un cambio O hacer una
   * pregunta. Le pasamos el CONTEXTO COMPLETO del flujo (nombre + grafo + notas del lienzo + nodo seleccionado)
   * y el modelo decide: `{kind:'edit', graph}` si pide cambiar, o `{kind:'answer', text}` si pregunta/comenta.
   */
  async chatGraph(
    graph: unknown,
    message: string,
    workspaceId: string,
    opts: { name?: string; notes?: string[]; selected?: string; model?: string; page?: string } = {},
  ): Promise<{ kind: 'edit'; name: string; graph: WorkflowGraph } | { kind: 'answer'; text: string }> {
    const clean = this.cleanPrompt(message);
    const current = this.parseGraph(graph); // valida que el grafo de entrada esté bien formado

    // Cuota diaria por workspace (M33): corta ANTES de gastar si ya superó su presupuesto de IA.
    const limit = this.tokenLimit();
    if (limit > 0 && (await this.p.usage.todayTokens(workspaceId)) >= limit) {
      throw new BadRequestException('Has alcanzado el límite diario de IA de tu espacio de trabajo. Inténtalo de nuevo mañana o sube el límite.');
    }
    const llm = await this.buildRouter(workspaceId); // BYOK (M35): claves del workspace o de plataforma
    const chosen = opts.model?.trim() || process.env.LLM_MODEL || 'llama-3.3-70b-versatile';

    const system = [
      // Contexto de identidad (M37): quién es el asistente, de qué va AgentFlow y en qué página está el usuario.
      buildAssistantPreamble(opts.page),
      '',
      await this.catalogPrompt(workspaceId),
      '',
      'MODO CHAT DEL EDITOR: el usuario está VIENDO este flujo en el lienzo y conversa contigo. Puede pedir un CAMBIO o hacer una PREGUNTA sobre el flujo.',
      'Responde SIEMPRE con UN ÚNICO objeto JSON, sin texto alrededor ni ```:',
      '- Si pide crear, modificar o arreglar el flujo: {"kind":"edit","name":"<nombre corto>","graph":{"nodes":[...],"edges":[...],"comments":[...]}} con el flujo COMPLETO resultante (todos los nodos con sus posiciones y configs, no solo el cambio).',
      '- Si pregunta, pide una explicación o solo comenta (no pide cambiar nada): {"kind":"answer","text":"<respuesta clara y breve, en el MISMO idioma del usuario>"}.',
      'NOTAS ADHESIVAS (post-it del lienzo): para AÑADIR una nota que explique el flujo, devuelve un "edit" incluyendo la nota en "comments". Cada nota es {"id":"note-1","text":"Título\\n- primer punto\\n- segundo punto","position":{"x":<n>,"y":<n>},"color":"amber"}: la 1ª línea es el título y las líneas que empiezan por "- " son viñetas. Colores válidos: amber, slate, sky, emerald, pink, violet. Colócala cerca del flujo sin taparlo (p. ej. encima del disparador, con y unos 120px por encima del nodo más alto). NO afecta a la ejecución. IMPORTANTE: reenvía SIEMPRE las notas existentes junto a las nuevas para no borrarlas.',
      'Apóyate en el CONTEXTO del flujo que te doy para responder. No inventes ids de conectores/agentes: usa solo los del catálogo.',
    ].join('\n');

    const ctx: string[] = [];
    if (opts.name?.trim()) ctx.push(`Nombre del flujo: ${opts.name.trim()}`);
    ctx.push('Flujo ACTUAL (JSON):', JSON.stringify({ nodes: current.nodes, edges: current.edges, comments: current.comments ?? [] }));
    const notes = (opts.notes ?? []).map((n) => (n ?? '').trim()).filter(Boolean).slice(0, 20);
    if (notes.length) ctx.push('', 'Notas que el usuario dejó en el lienzo:', ...notes.map((n) => `- ${n}`));
    if (opts.selected?.trim()) ctx.push('', `Ahora mismo el usuario tiene seleccionado el nodo con key «${opts.selected.trim()}» (búscalo en el JSON).`);
    const user = [...ctx, '', 'Mensaje del usuario:', clean].join('\n');

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
          : [...base, { role: 'user' as const, content: `Tu respuesta anterior no fue válida (${lastErr}). Devuelve SOLO el objeto JSON con "kind":"edit" o "kind":"answer".` }];
      let res;
      try {
        res = await llm.chat({ model: chosen, messages });
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
      const o = (parsed ?? {}) as { kind?: string; text?: string; answer?: string; name?: string; graph?: unknown; nodes?: unknown };
      // Respuesta de texto (pregunta): no toca el flujo. Detecta `kind:'answer'` o un objeto con texto y sin grafo.
      const isAnswer = o.kind === 'answer' || (o.graph === undefined && o.nodes === undefined && (typeof o.text === 'string' || typeof o.answer === 'string'));
      if (isAnswer) {
        const text = String(o.text ?? o.answer ?? '').trim();
        if (text) return { kind: 'answer', text: text.slice(0, 4000) };
        lastErr = 'respuesta de texto vacía';
        continue;
      }
      // Edición: valida schema + DAG + inicio, igual que la generación.
      const g = WorkflowGraphSchema.safeParse(o.graph ?? parsed);
      if (!g.success) {
        lastErr = `estructura inválida: ${JSON.stringify(g.error.issues.slice(0, 2))}`;
        continue;
      }
      const dag = validateDag(g.data);
      if (!dag.valid) {
        lastErr = `no es un DAG válido: ${dag.errors.join('; ')}`;
        continue;
      }
      if (!g.data.nodes.some((n) => n.type === 'trigger')) {
        lastErr = 'el flujo debe tener un nodo de inicio (trigger)';
        continue;
      }
      const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : opts.name?.trim() || 'Automatización con IA';
      return { kind: 'edit', name, graph: g.data };
    }
    if (rateLimited) {
      throw new BadRequestException(
        'La IA ha alcanzado su límite de uso por ahora. Inténtalo de nuevo en unos minutos, o conecta otro proveedor de IA (sube el plan de Groq o añade una clave de OpenAI).',
      );
    }
    throw new BadRequestException(`La IA no pudo responder. ${lastErr}`);
  }

  private cleanPrompt(prompt: string): string {
    const clean = (prompt ?? '').trim();
    if (!clean) throw new BadRequestException('Describe lo que quieres automatizar.');
    // Tope de entrada: acota el coste del LLM por petición (la salida ya está topada por el proveedor).
    if (clean.length > 2000) throw new BadRequestException('La descripción es demasiado larga (máx. 2000 caracteres).');
    return clean;
  }

  /** System prompt con el catálogo de nodos + los conectores/agentes REALES del workspace (ids válidos). */
  private async catalogPrompt(workspaceId: string): Promise<string> {
    const [connectors, agents] = await Promise.all([
      this.p.connectors.listByWorkspace(workspaceId),
      this.p.agents.list(workspaceId),
    ]);
    return buildGeneratePrompt(
      connectors.map((c) => ({ id: c.id, provider: c.provider, key: c.key })),
      agents.map((a) => ({ id: a.id, name: a.name })),
    );
  }

  /** Límite diario de tokens LLM por workspace (0 = ilimitado). Evita que un usuario agote el común. */
  private tokenLimit(): number {
    return Math.max(0, Number(process.env.WORKSPACE_TOKEN_LIMIT ?? 0) || 0);
  }

  /** Bucle común: pide el JSON al LLM, extrae, valida (schema + DAG) y reintenta 1 vez con el error. */
  private async runLlmGraph(system: string, user: string, workspaceId: string, model?: string): Promise<{ name: string; graph: WorkflowGraph }> {
    // Cuota por workspace (M33): si ya superó su presupuesto diario de IA, corta ANTES de gastar más.
    const limit = this.tokenLimit();
    if (limit > 0 && (await this.p.usage.todayTokens(workspaceId)) >= limit) {
      throw new BadRequestException('Has alcanzado el límite diario de IA de tu espacio de trabajo. Inténtalo de nuevo mañana o sube el límite.');
    }
    // Router del workspace (M35 BYOK): usa sus propias claves si las tiene; si no, las de plataforma.
    const llm = await this.buildRouter(workspaceId);
    // Modelo elegido por el usuario (M34), o el por defecto. La CADENA DE FALLBACK del router (M33) ya cubre
    // que este proveedor se agote cayendo a otro; no hace falta un fallback de modelo aquí.
    const chosen = model?.trim() || process.env.LLM_MODEL || 'llama-3.3-70b-versatile';
    const models = [chosen];
    const base = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ];
    let lastErr = 'sin respuesta';
    let rateLimited = false; // ¿el fallo fue por límite de uso del proveedor? → mensaje claro al usuario
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const messages =
          attempt === 0
            ? base
            : [...base, { role: 'user' as const, content: `El JSON anterior no fue válido (${lastErr}). Devuelve SOLO el JSON corregido, sin texto.` }];
        let res;
        try {
          res = await llm.chat({ model, messages });
        } catch (e) {
          // El modelo falló (límite de uso, contexto, red). NO revienta con 500: pasa al siguiente modelo
          // (reintentar el mismo modelo agotado no sirve).
          const msg = e instanceof Error ? e.message : String(e);
          if (isRateLimitError(msg)) rateLimited = true;
          lastErr = `error del modelo: ${msg}`;
          break;
        }
        // Contabiliza los tokens consumidos hacia la cuota del workspace (best-effort: no rompe la generación).
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
        const obj = (parsed ?? {}) as { name?: unknown; graph?: unknown };
        const g = WorkflowGraphSchema.safeParse(obj.graph ?? parsed); // acepta {name,graph} o el grafo suelto
        if (!g.success) {
          lastErr = `estructura inválida: ${JSON.stringify(g.error.issues.slice(0, 2))}`;
          continue;
        }
        const dag = validateDag(g.data);
        if (!dag.valid) {
          lastErr = `no es un DAG válido: ${dag.errors.join('; ')}`;
          continue;
        }
        // Un grafo vacío/sin inicio es válido para el schema+DAG, pero NO es un flujo: reintenta en vez de
        // devolverlo (si no, en la edición sobrescribiría y destruiría el flujo del usuario).
        if (!g.data.nodes.some((n) => n.type === 'trigger')) {
          lastErr = 'el flujo debe tener un nodo de inicio (trigger)';
          continue;
        }
        const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 80) : 'Automatización con IA';
        return { name, graph: g.data };
      }
    }
    // Límite de uso del proveedor: mensaje claro y accionable, sin filtrar el error crudo (429, org id…).
    if (rateLimited) {
      throw new BadRequestException(
        'La IA ha alcanzado su límite de uso por ahora. Inténtalo de nuevo en unos minutos, o conecta otro proveedor de IA (sube el plan de Groq o añade una clave de OpenAI).',
      );
    }
    throw new BadRequestException(`La IA no pudo generar un flujo válido. ${lastErr}`);
  }

  private parseGraph(graph: unknown): WorkflowGraph {
    const res = WorkflowGraphSchema.safeParse(graph);
    if (!res.success) {
      throw new BadRequestException({ message: 'Grafo mal formado', issues: res.error.issues });
    }
    return res.data;
  }
}
