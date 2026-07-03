import type { WorkflowGraph } from '@core/contracts';
import type {
  IWorkflowRepository,
  WorkflowRecord,
  WorkflowWithGraph,
  WorkflowVersionRecord,
  INodeRunRepository,
  NodeRunUpsert,
} from '@core/engine';

let seq = 0;
const emptyGraph = (): WorkflowGraph => ({ nodes: [], edges: [] });
const clone = (g: WorkflowGraph): WorkflowGraph => JSON.parse(JSON.stringify(g)) as WorkflowGraph;

interface Stored {
  record: WorkflowRecord;
  draft: WorkflowGraph;
  versions: WorkflowVersionRecord[]; // published (inmutables)
  activeVersionId: string | null;
}

/** Repositorio de workflows in-memory con ciclo de vida draft/published (M4p). */
export class InMemoryWorkflowRepository implements IWorkflowRepository {
  private readonly store = new Map<string, Stored>();

  private toGraphView(s: Stored): WorkflowWithGraph {
    return {
      id: s.record.id,
      workspaceId: s.record.workspaceId,
      name: s.record.name,
      status: s.record.status,
      currentVersionId: s.activeVersionId,
      version: s.versions.length,
      graph: s.draft,
    };
  }

  async create(input: { workspaceId: string; name: string; graph?: WorkflowGraph }): Promise<WorkflowWithGraph> {
    const id = `wf_${++seq}`;
    const stored: Stored = {
      record: { id, workspaceId: input.workspaceId, name: input.name, status: 'DRAFT', currentVersionId: null, version: 0 },
      draft: input.graph ? clone(input.graph) : emptyGraph(),
      versions: [],
      activeVersionId: null,
    };
    this.store.set(id, stored);
    return this.toGraphView(stored);
  }

  async list(workspaceId: string): Promise<WorkflowRecord[]> {
    return [...this.store.values()].filter((s) => s.record.workspaceId === workspaceId).map((s) => ({ ...s.record, version: s.versions.length, currentVersionId: s.activeVersionId }));
  }

  async get(id: string): Promise<WorkflowWithGraph | null> {
    const s = this.store.get(id);
    return s ? this.toGraphView(s) : null;
  }

  async saveGraph(id: string, graph: WorkflowGraph): Promise<WorkflowWithGraph> {
    const s = this.require(id);
    s.draft = clone(graph);
    return this.toGraphView(s);
  }

  async publish(id: string): Promise<WorkflowVersionRecord> {
    const s = this.require(id);
    const version = s.versions.length + 1;
    const record: WorkflowVersionRecord = {
      id: `${id}:v${version}`,
      workflowId: id,
      version,
      state: 'published',
      graph: clone(s.draft), // snapshot inmutable
      publishedAt: new Date().toISOString(),
    };
    s.versions.push(record);
    s.activeVersionId = record.id;
    s.record.status = 'ACTIVE';
    s.record.currentVersionId = record.id;
    return record;
  }

  async listVersions(id: string): Promise<WorkflowVersionRecord[]> {
    const s = this.require(id);
    const draft: WorkflowVersionRecord = {
      id: `${id}:draft`,
      workflowId: id,
      version: s.versions.length + 1,
      state: 'draft',
      graph: s.draft,
      publishedAt: null,
    };
    return [...s.versions].reverse().concat(draft);
  }

  async getVersion(versionId: string): Promise<WorkflowVersionRecord | null> {
    for (const s of this.store.values()) {
      if (versionId === `${s.record.id}:draft`) {
        return { id: versionId, workflowId: s.record.id, version: s.versions.length + 1, state: 'draft', graph: s.draft, publishedAt: null };
      }
      const v = s.versions.find((x) => x.id === versionId);
      if (v) return v;
    }
    return null;
  }

  async resolveRunVersion(id: string): Promise<WorkflowVersionRecord> {
    const s = this.require(id);
    if (s.activeVersionId) {
      const v = s.versions.find((x) => x.id === s.activeVersionId);
      if (v) return v;
    }
    return this.publish(id); // auto-publica el draft si no hay versión activa
  }

  private require(id: string): Stored {
    const s = this.store.get(id);
    if (!s) throw new Error(`Workflow no encontrado: ${id}`);
    return s;
  }
}

/** Proyección NodeRun in-memory. */
export class InMemoryNodeRunRepository implements INodeRunRepository {
  private readonly runs = new Map<string, Map<string, { nodeKey: string; status: string }>>();

  async upsert(run: NodeRunUpsert): Promise<void> {
    const m = this.runs.get(run.executionId) ?? new Map();
    m.set(run.nodeKey, { nodeKey: run.nodeKey, status: run.status });
    this.runs.set(run.executionId, m);
  }

  async list(executionId: string): Promise<Array<{ nodeKey: string; status: string }>> {
    return [...(this.runs.get(executionId)?.values() ?? [])];
  }
}
