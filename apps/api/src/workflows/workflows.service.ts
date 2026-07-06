import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { WorkflowGraphSchema, type WorkflowGraph } from '@core/contracts';
import { validateDag } from '@core/domain';
import { createLlmRouter } from '@core/llm';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { assertInWorkspace } from '../tenant/tenant.util';
import { TriggersService } from '../triggers/triggers.service';
import { extractJsonObject, buildGeneratePrompt } from './generate.util';

@Injectable()
export class WorkflowsService {
  private readonly llm = createLlmRouter(); // «Construir con IA» (M29): lee el proveedor de env (Groq…)

  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    private readonly triggers: TriggersService,
  ) {}

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
    return this.p.workflows.publish(id);
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
   * LLM un JSON con el catálogo de nodos + los conectores/agentes REALES del workspace, y VALIDA (schema +
   * DAG). Si sale inválido, reintenta UNA vez pasándole el error. Devuelve el nombre sugerido + el grafo.
   */
  async generate(prompt: string, workspaceId: string): Promise<{ name: string; graph: WorkflowGraph }> {
    if (!prompt?.trim()) throw new BadRequestException('Describe lo que quieres automatizar.');
    const [connectors, agents] = await Promise.all([
      this.p.connectors.listByWorkspace(workspaceId),
      this.p.agents.list(workspaceId),
    ]);
    const system = buildGeneratePrompt(
      connectors.map((c) => ({ id: c.id, provider: c.provider, key: c.key })),
      agents.map((a) => ({ id: a.id, name: a.name })),
    );
    const model = process.env.LLM_MODEL ?? 'llama-3.3-70b-versatile';
    const base = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: prompt.trim() },
    ];

    let lastErr = 'sin respuesta';
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages =
        attempt === 0
          ? base
          : [...base, { role: 'user' as const, content: `El JSON anterior no fue válido (${lastErr}). Devuelve SOLO el JSON corregido, sin texto.` }];
      const res = await this.llm.chat({ model, messages });
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
      const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 80) : 'Automatización con IA';
      return { name, graph: g.data };
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
