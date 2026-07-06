import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { WorkflowGraphSchema, type WorkflowGraph } from '@core/contracts';
import { validateDag } from '@core/domain';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { assertInWorkspace } from '../tenant/tenant.util';
import { TriggersService } from '../triggers/triggers.service';

@Injectable()
export class WorkflowsService {
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

  private parseGraph(graph: unknown): WorkflowGraph {
    const res = WorkflowGraphSchema.safeParse(graph);
    if (!res.success) {
      throw new BadRequestException({ message: 'Grafo mal formado', issues: res.error.issues });
    }
    return res.data;
  }
}
