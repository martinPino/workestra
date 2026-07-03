import type { PrismaClient } from '@prisma/client';
import type { WorkflowGraph } from '@core/contracts';
import type {
  IWorkflowRepository,
  WorkflowRecord,
  WorkflowWithGraph,
  WorkflowVersionRecord,
  WorkflowVersionState,
  INodeRunRepository,
  NodeRunUpsert,
} from '@core/engine';

const emptyGraph = (): WorkflowGraph => ({ nodes: [], edges: [] });


function toVersion(r: any): WorkflowVersionRecord {
  return {
    id: r.id,
    workflowId: r.workflowId,
    version: r.version,
    state: (r.state ?? 'draft') as WorkflowVersionState,
    graph: (r.graphSnapshot as unknown as WorkflowGraph) ?? emptyGraph(),
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
  };
}

/** Repositorio de workflows sobre Postgres con ciclo de vida draft/published (M4p). */
export class PrismaWorkflowRepository implements IWorkflowRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private draftOf(id: string) {
    return this.prisma.workflowVersion.findFirst({ where: { workflowId: id, state: 'draft' } });
  }

  async create(input: { workspaceId: string; name: string; graph?: WorkflowGraph }): Promise<WorkflowWithGraph> {
    const wf = await this.prisma.workflow.create({ data: { workspaceId: input.workspaceId, name: input.name } });
    await this.prisma.workflowVersion.create({
      data: {
        workflowId: wf.id,
        version: 0,
        state: 'draft',

        graphSnapshot: (input.graph ?? emptyGraph()) as any,
        createdBy: 'system',
      },
    });
    return {
      id: wf.id,
      workspaceId: wf.workspaceId,
      name: wf.name,
      status: wf.status,
      currentVersionId: null,
      version: 0,
      graph: input.graph ?? emptyGraph(),
    };
  }

  async list(workspaceId: string): Promise<WorkflowRecord[]> {
    const rows = await this.prisma.workflow.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
    if (rows.length === 0) return [];
    // Conteo de versiones publicadas por workflow en UNA sola consulta (evita el N+1 que la extensión
    // RLS amplifica a 1+N transacciones: una por fila). groupBy agrega en la BD, no por fila.
    const counts = await this.prisma.workflowVersion.groupBy({
      by: ['workflowId'],
      where: { workflowId: { in: rows.map((r) => r.id) }, state: 'published' },
      _count: { _all: true },
    });
    const publishedByWorkflow = new Map(counts.map((c) => [c.workflowId, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      name: r.name,
      status: r.status,
      currentVersionId: r.currentVersionId,
      version: publishedByWorkflow.get(r.id) ?? 0,
    }));
  }

  async get(id: string): Promise<WorkflowWithGraph | null> {
    const wf = await this.prisma.workflow.findUnique({ where: { id } });
    if (!wf) return null;
    const draft = await this.draftOf(id);
    const version = await this.prisma.workflowVersion.count({ where: { workflowId: id, state: 'published' } });
    return {
      id: wf.id,
      workspaceId: wf.workspaceId,
      name: wf.name,
      status: wf.status,
      currentVersionId: wf.currentVersionId,
      version,
      graph: (draft?.graphSnapshot as unknown as WorkflowGraph) ?? emptyGraph(),
    };
  }

  async saveGraph(id: string, graph: WorkflowGraph): Promise<WorkflowWithGraph> {
    const draft = await this.draftOf(id);
    if (draft) {

      await this.prisma.workflowVersion.update({ where: { id: draft.id }, data: { graphSnapshot: graph as any } });
    } else {

      await this.prisma.workflowVersion.create({ data: { workflowId: id, version: 0, state: 'draft', graphSnapshot: graph as any, createdBy: 'system' } });
    }
    return (await this.get(id))!;
  }

  async publish(id: string): Promise<WorkflowVersionRecord> {
    const draft = await this.draftOf(id);
    const count = await this.prisma.workflowVersion.count({ where: { workflowId: id, state: 'published' } });
    const version = count + 1;
    const v = await this.prisma.workflowVersion.create({
      data: {
        workflowId: id,
        version,
        state: 'published',

        graphSnapshot: (draft?.graphSnapshot ?? emptyGraph()) as any,
        createdBy: 'system',
        publishedAt: new Date(),
      },
    });
    await this.prisma.workflow.update({ where: { id }, data: { currentVersionId: v.id, status: 'ACTIVE' } });
    return toVersion(v);
  }

  async listVersions(id: string): Promise<WorkflowVersionRecord[]> {
    const rows = await this.prisma.workflowVersion.findMany({ where: { workflowId: id }, orderBy: { version: 'desc' } });
    return rows.map(toVersion);
  }

  async getVersion(versionId: string): Promise<WorkflowVersionRecord | null> {
    const r = await this.prisma.workflowVersion.findUnique({ where: { id: versionId } });
    return r ? toVersion(r) : null;
  }

  async resolveRunVersion(id: string): Promise<WorkflowVersionRecord> {
    const active = await this.prisma.workflowVersion.findFirst({
      where: { workflowId: id, state: 'published' },
      orderBy: { version: 'desc' },
    });
    return active ? toVersion(active) : this.publish(id);
  }
}

/** Proyección NodeRun sobre Postgres. */
export class PrismaNodeRunRepository implements INodeRunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(run: NodeRunUpsert): Promise<void> {
    await this.prisma.nodeRun.upsert({
      where: { executionId_nodeKey: { executionId: run.executionId, nodeKey: run.nodeKey } },
      update: { status: run.status, attempt: run.attempt ?? undefined, finishedAt: run.finishedAt ?? undefined },
      create: {
        executionId: run.executionId,
        nodeKey: run.nodeKey,
        status: run.status,
        attempt: run.attempt ?? 1,
        startedAt: run.startedAt ?? undefined,
        finishedAt: run.finishedAt ?? undefined,
      },
    });
  }

  async list(executionId: string): Promise<Array<{ nodeKey: string; status: string }>> {
    const rows = await this.prisma.nodeRun.findMany({ where: { executionId } });
    return rows.map((r) => ({ nodeKey: r.nodeKey, status: r.status }));
  }
}
