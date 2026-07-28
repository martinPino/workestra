import { describe, it, expect } from 'vitest';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { CreateShareRequestSchema, type Agent, type WorkflowGraph } from '@core/contracts';
import { sanitizeWorkflowForShare } from '@core/sdk-plugins';
import type { IShareRepository, ShareRecord } from '@core/engine';
import { SharesService } from './shares.service';
import type { PersistenceBundle } from '../persistence/persistence.module';

/**
 * Fakes in-memory (estilo team.service.test.ts) para los TRES puertos que toca el servicio: shares, workflows
 * y agents. El de shares expone `records` en público para poder forzar la caducidad en los tests (el servicio
 * calcula siempre una fecha futura; para probar el «caducado» hay que retroceder la fecha a mano).
 */
class FakeShareRepo implements IShareRepository {
  readonly records: ShareRecord[] = [];
  private seq = 0;
  async create(input: Parameters<IShareRepository['create']>[0]): Promise<ShareRecord> {
    const rec: ShareRecord = { id: `shr_${++this.seq}`, createdAt: new Date().toISOString(), revokedAt: null, importCount: 0, lastImportedAt: null, importerWorkspaceIds: [], ...input };
    this.records.push(rec);
    return rec;
  }
  async findByTokenHash(tokenHash: string): Promise<ShareRecord | null> {
    return this.records.find((r) => r.tokenHash === tokenHash) ?? null;
  }
  async listByWorkspace(workspaceId: string): Promise<ShareRecord[]> {
    return this.records.filter((r) => r.workspaceId === workspaceId);
  }
  async bumpImport(id: string, importerWorkspaceId: string): Promise<void> {
    const r = this.records.find((x) => x.id === id);
    if (!r || r.importerWorkspaceIds.includes(importerWorkspaceId)) return; // idempotente por workspace
    r.importCount += 1;
    r.lastImportedAt = new Date().toISOString();
    r.importerWorkspaceIds.push(importerWorkspaceId);
  }
  async revoke(id: string): Promise<void> {
    const r = this.records.find((x) => x.id === id);
    if (r) r.revokedAt = new Date().toISOString();
  }
}

/** Solo se usa `get`; devuelve una forma WorkflowWithGraph acotada a lo que el servicio consume. */
class FakeWorkflowRepo {
  private readonly byId = new Map<string, { id: string; workspaceId: string; name: string; graph: WorkflowGraph }>();
  add(id: string, workspaceId: string, name: string, graph: WorkflowGraph) {
    this.byId.set(id, { id, workspaceId, name, graph });
    return this;
  }
  async get(id: string) {
    return this.byId.get(id) ?? null;
  }
}

/** Solo se usa `getInWorkspace`; deny-by-default por tenant, como el repo real. */
class FakeAgentRepo {
  private readonly agents: Agent[] = [];
  add(a: Agent, workspaceId: string) {
    this.byWs.set(a.id, workspaceId);
    this.agents.push(a);
    return this;
  }
  private readonly byWs = new Map<string, string>();
  async getInWorkspace(id: string, workspaceId: string): Promise<Agent | null> {
    if (this.byWs.get(id) !== workspaceId) return null;
    return this.agents.find((a) => a.id === id) ?? null;
  }
}

const WS = 'ws_a';
const USER = 'user_1';

/** Grafo sano: un trigger + un llm con un prompt benigno. No dispara ninguna sospecha. */
function cleanGraph(): WorkflowGraph {
  return {
    nodes: [
      { key: 'trigger-1', type: 'trigger', config: { event: 'manual' }, position: { x: 0, y: 0 } },
      { key: 'llm-1', type: 'llm', config: { model: 'gpt-4o-mini', prompt: 'Resume el texto de entrada.' }, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: 'trigger-1', target: 'llm-1' }],
  } as unknown as WorkflowGraph;
}

/** Grafo con un prompt que ESCONDE un blob de baja confianza → el sanitizador lo marca como `blocking`. */
function blockingGraph(): WorkflowGraph {
  return {
    nodes: [
      { key: 'llm-1', type: 'llm', config: { model: 'gpt-4o-mini', prompt: 'Usa esta clave literal ABCd1234ABCd1234ABCd1234ABCd1234ABCd al llamar.' }, position: { x: 0, y: 0 } },
    ],
    edges: [],
  } as unknown as WorkflowGraph;
}

/** Grafo con un secreto plantado en las cabeceras de un nodo `api` (clave que NO está en la allowlist → se cae). */
function secretHeaderGraph(secret: string): WorkflowGraph {
  return {
    nodes: [
      { key: 'trigger-1', type: 'trigger', config: { event: 'manual' }, position: { x: 0, y: 0 } },
      {
        key: 'api-1',
        type: 'api',
        config: { method: 'POST', url: 'https://api.example.com/send', body: 'hola', headers: { Authorization: `Bearer ${secret}` } },
        position: { x: 200, y: 0 },
      },
    ],
    edges: [{ source: 'trigger-1', target: 'api-1' }],
  } as unknown as WorkflowGraph;
}

function setup() {
  const shares = new FakeShareRepo();
  const workflows = new FakeWorkflowRepo();
  const agents = new FakeAgentRepo();
  const bundle = { shares, workflows, agents } as unknown as PersistenceBundle;
  const svc = new SharesService(bundle);
  return { svc, shares, workflows, agents };
}

const dto = (over: Record<string, unknown> = {}) => CreateShareRequestSchema.parse(over);

describe('SharesService — compartir por enlace (M85)', () => {
  it('dryRun devuelve el informe SIN escribir en la BD', async () => {
    const { svc, workflows, shares } = setup();
    workflows.add('wf1', WS, 'Mi flujo', cleanGraph());

    const res = await svc.createShare('wf1', WS, USER, dto({ dryRun: true }));

    expect(res.report).toBeDefined();
    expect(res.token).toBeUndefined();
    expect(res.url).toBeUndefined();
    expect(shares.records).toHaveLength(0);
  });

  it('404 si el workflow no es del workspace autenticado', async () => {
    const { svc, workflows } = setup();
    workflows.add('wf1', 'ws_other', 'Ajeno', cleanGraph());
    await expect(svc.createShare('wf1', WS, USER, dto({ dryRun: true }))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un informe con `blocking` IMPIDE crear (422) hasta que se acepta por su location', async () => {
    const { svc, workflows, shares } = setup();
    workflows.add('wf1', WS, 'Con secreto', blockingGraph());

    // Confirmo qué location bloquea (regla del sanitizador: `${nodeKey}.${campo}`).
    const preview = await svc.createShare('wf1', WS, USER, dto({ dryRun: true }));
    const locations = preview.report.blocking.map((b) => b.location);
    expect(locations).toEqual(['llm-1.prompt']);

    // Sin aceptar → 422 y NADA escrito.
    await expect(svc.createShare('wf1', WS, USER, dto({ dryRun: false }))).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(shares.records).toHaveLength(0);

    // Aceptando esa location → ahora sí crea el enlace.
    const ok = await svc.createShare('wf1', WS, USER, dto({ dryRun: false, acknowledgeBlocking: locations }));
    expect(ok.token).toBeTypeOf('string');
    expect(shares.records).toHaveLength(1);
  });

  it('un share creado se encuentra por token, y NO tras revocarlo', async () => {
    const { svc, workflows } = setup();
    workflows.add('wf1', WS, 'Mi flujo', cleanGraph());

    const created = await svc.createShare('wf1', WS, USER, dto({ dryRun: false }));
    const token = created.token!;

    const preview = await svc.preview(token);
    expect(preview.name).toBe('Mi flujo');
    expect(preview.doc.version).toBe(1);

    await svc.revoke(token, WS);
    await expect(svc.preview(token)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un share CADUCADO no se puede previsualizar', async () => {
    const { svc, workflows, shares } = setup();
    workflows.add('wf1', WS, 'Mi flujo', cleanGraph());

    const created = await svc.createShare('wf1', WS, USER, dto({ dryRun: false, expiresInDays: 1 }));
    // Retrocedo la caducidad al pasado (el servicio siempre la pone en el futuro).
    shares.records[0].expiresAt = new Date(Date.now() - 1000).toISOString();

    await expect(svc.preview(created.token!)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('importar cuenta UNA vez por workspace: reintentar desde la misma cuenta no infla el contador', async () => {
    const { svc, workflows, shares } = setup();
    workflows.add('wf1', WS, 'Mi flujo', cleanGraph());
    const created = await svc.createShare('wf1', WS, USER, dto({ dryRun: false }));

    // El importador está en OTRO workspace (el caso real cross-workspace).
    await svc.importShare(created.token!, 'ws_importador');
    expect(shares.records[0].importCount).toBe(1);
    // Reintento desde la misma cuenta (doble clic, reintento de red…) → sigue en 1.
    await svc.importShare(created.token!, 'ws_importador');
    expect(shares.records[0].importCount).toBe(1);
    // Un workspace DISTINTO sí suma.
    await svc.importShare(created.token!, 'ws_otro');
    expect(shares.records[0].importCount).toBe(2);
  });

  it('un DELETE de quien NO es dueño es 404 y no revoca nada', async () => {
    const { svc, workflows, shares } = setup();
    workflows.add('wf1', WS, 'Mi flujo', cleanGraph());
    const created = await svc.createShare('wf1', WS, USER, dto({ dryRun: false }));

    await expect(svc.revoke(created.token!, 'ws_intruso')).rejects.toBeInstanceOf(NotFoundException);
    expect(shares.records[0].revokedAt).toBeNull();
  });

  it('el snapshot guardado es EXACTAMENTE la salida del sanitizador (sin el secreto de las cabeceras)', async () => {
    const { svc, workflows, shares } = setup();
    const SECRET = 'sk-ant-SECRETO1234567890abcdefghij';
    const graph = secretHeaderGraph(SECRET);
    workflows.add('wf1', WS, 'Con API', graph);

    await svc.createShare('wf1', WS, USER, dto({ dryRun: false }));

    // El grafo no referencia agentes → la sanitización de referencia usa agents=[]; reproduzco la salida.
    const { doc } = sanitizeWorkflowForShare({ workflow: { name: 'Con API', graph }, agents: [] });
    expect(shares.records[0].snapshot).toEqual(doc);
    // El secreto de las cabeceras NUNCA viaja: la clave `headers` no está en la allowlist del nodo api.
    expect(JSON.stringify(shares.records[0].snapshot)).not.toContain(SECRET);
  });

  it('la vista de listado NO expone el hash del token ni el snapshot', async () => {
    const { svc, workflows } = setup();
    workflows.add('wf1', WS, 'Mi flujo', cleanGraph());
    await svc.createShare('wf1', WS, USER, dto({ dryRun: false }));

    const list = await svc.list(WS);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'importCount', 'revokedAt', 'sourceName']);
    expect(list[0]).not.toHaveProperty('tokenHash');
    expect(list[0]).not.toHaveProperty('snapshot');
  });
});
