import { Injectable, Inject, NotFoundException, BadRequestException } from '../http/common';
import type { Queue } from 'bullmq';
import { emptyContext, type ExecutionStatus, type TriggerType } from '@core/contracts';
import { validateDag } from '@core/domain';
import { WorkflowRunner, type RunInput } from '@core/engine';
import { SystemClock, CuidIdGenerator } from '@core/infra';
import type { NodeExecutorRegistry } from '@core/sdk-plugins';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { assertInWorkspace } from '../tenant/tenant.util';
import { NODE_REGISTRY } from './node-registry';
import { EXECUTION_QUEUE } from './queue';
import { ExecutionEventHub } from './execution-event-hub';

const VALID_STATUSES: ExecutionStatus[] = ['QUEUED', 'RUNNING', 'PAUSED', 'WAITING_HUMAN', 'SUCCEEDED', 'FAILED', 'CANCELLED'];

@Injectable()
export class ExecutionsService {
  private readonly clock = new SystemClock();
  private readonly ids = new CuidIdGenerator();

  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    @Inject(NODE_REGISTRY) private readonly registry: NodeExecutorRegistry,
    @Inject(EXECUTION_QUEUE) private readonly queue: Queue | null,
    private readonly hub: ExecutionEventHub,
  ) {}

  /**
   * Crea la ejecución (para devolver su id al instante), la corre en background y emite eventos.
   * `triggerType` (por defecto 'manual') queda GRABADO de forma durable en la ejecución: así la tabla
   * de Ejecuciones distingue disparos manuales de webhooks/cron/api en vez de mostrar todo como 'manual'.
   */
  async start(
    workflowId: string,
    workspaceId: string,
    contextInput?: Record<string, unknown>,
    triggerType: TriggerType = 'manual',
  ) {
    const wf = await this.p.workflows.get(workflowId);
    assertInWorkspace(wf?.workspaceId, workspaceId, 'Workflow');

    // Cuota por workspace (M33): no se arrancan ejecuciones si el workspace ya superó su tope diario de IA
    // (cubre también webhooks/cron, que es donde más se dispara el gasto de agentes).
    const limit = Math.max(0, Number(process.env.WORKSPACE_TOKEN_LIMIT ?? 0) || 0);
    if (limit > 0 && (await this.p.usage.todayTokens(workspaceId)) >= limit) {
      throw new BadRequestException('Este espacio de trabajo alcanzó su límite diario de IA. Inténtalo de nuevo mañana o sube el límite.');
    }

    // Pin de versión: la ejecución se ancla a la versión resuelta (published inmutable). Editar y
    // publicar después NO altera esta ejecución (criterio de aceptación M4p).
    const runVersion = await this.p.workflows.resolveRunVersion(workflowId);

    const validation = validateDag(runVersion.graph);
    if (!validation.valid) {
      throw new BadRequestException({ message: 'Grafo inválido (no es un DAG)', errors: validation.errors });
    }

    const base = emptyContext();
    const initialContext = contextInput
      ? {
          ...base,
          ...contextInput,
          variables: { ...base.variables, ...((contextInput.variables as Record<string, unknown>) ?? {}) },
        }
      : base;

    const execution = await this.p.executions.create({
      workflowVersionId: runVersion.id,
      workspaceId, // verificado == wf.workspaceId
      triggerType,
      context: initialContext,
    });

    const input: RunInput = {
      executionId: execution.id,
      workflowVersionId: runVersion.id,
      // M82: identidad ESTABLE del flujo (la versión cambia al publicar). La usan los nodos con estado
      // durable —p. ej. el paso de IA que recuerda lo que ya envió— para no perder memoria al editar.
      workflowId: runVersion.workflowId,
      workspaceId,
      graph: runVersion.graph,
      triggerType,
      initialContext,
    };

    if (this.queue) {
      // Despacho DURABLE: la ejecución se encola en BullMQ (jobId = executionId para dedupe). El
      // worker la procesa; si cae, BullMQ la reintenta y el runner reanuda desde el último nodo.
      await this.queue.add('run', input, {
        jobId: execution.id,
        attempts: 5,
        backoff: { type: 'fixed', delay: 400 },
        removeOnComplete: 200,
        removeOnFail: 200,
      });
      return { executionId: execution.id, status: 'QUEUED' as const, versionId: runVersion.id, version: runVersion.version };
    }

    // Despacho INLINE (por defecto): se ejecuta en el proceso de la API.
    this.runInline(input);

    return { executionId: execution.id, status: 'RUNNING' as const, versionId: runVersion.id, version: runVersion.version };
  }

  /** Arranca el runner en el proceso de la API (background). El stream ya emite éxito/fallo. */
  private runInline(input: RunInput): void {
    const runner = new WorkflowRunner({
      executions: this.p.executions,
      context: this.p.context,
      events: this.hub,
      registry: this.registry,
      clock: this.clock,
      ids: this.ids,
      usage: this.p.usage, // M33: los tokens de ejecución cuentan hacia la cuota diaria del workspace
    });
    void runner.run(input).catch(() => {
      /* execution.failed ya fue emitido al stream por el runner */
    });
  }

  /**
   * Reanuda una ejecución suspendida en `WAITING_HUMAN` (tras aprobar una revisión). Reconstruye el
   * RunInput desde la versión ANCLADA y marca como ya completados los nodos que tuvieron éxito; el
   * runner reanuda desde el checkpoint y el nodo Humano re-ejecuta leyendo la revisión resuelta.
   *
   * IDEMPOTENTE: solo reanuda si la ejecución sigue en `WAITING_HUMAN` (una segunda llamada la ve ya
   * `RUNNING`/`SUCCEEDED` y no hace nada, evitando doble ejecución). En modo cola RE-ENCOLA en BullMQ
   * (worker durable) con un `jobId` de reanudación DISTINTO del original para no chocar con el dedupe;
   * en inline ejecuta en el proceso de la API.
   *
   * @param resumeKey clave estable (p. ej. el id de la revisión) para el jobId de reanudación.
   */
  async resume(executionId: string, resumeKey = 'human'): Promise<void> {
    const execution = await this.p.executions.get(executionId);
    if (!execution) throw new NotFoundException(`Ejecución no encontrada: ${executionId}`);
    if (execution.status !== 'WAITING_HUMAN') return; // idempotente: ya reanudada o no suspendida
    const version = await this.p.workflows.getVersion(execution.workflowVersionId);
    if (!version) throw new NotFoundException(`Versión anclada no encontrada: ${execution.workflowVersionId}`);

    const runs = await this.p.nodeRuns.list(executionId);
    const resumeCompleted = runs.filter((r) => r.status === 'succeeded').map((r) => r.nodeKey);
    const initialContext = await this.p.context.load(executionId);
    // Continuidad del stream (M6): el runner reanudado sigue numerando tras lo ya persistido.
    const startSeq = (await this.p.events.lastSeq(executionId)) + 1;

    const input: RunInput = {
      executionId,
      workflowVersionId: execution.workflowVersionId,
      workflowId: version.workflowId, // M82: igual que en el arranque, para que el estado durable sea el mismo
      workspaceId: execution.workspaceId,
      graph: version.graph,
      triggerType: execution.triggerType,
      initialContext,
      resumeCompleted,
      startSeq,
    };

    if (this.queue) {
      // Durable: el worker deriva de nuevo `resumeCompleted` de NodeRun (Postgres) y carga el
      // contexto de Redis. jobId distinto del original (que sigue en removeOnComplete) → sin colisión.
      await this.queue.add('run', input, {
        jobId: `${executionId}:resume:${resumeKey}`,
        attempts: 5,
        backoff: { type: 'fixed', delay: 400 },
        removeOnComplete: 200,
        removeOnFail: 200,
      });
      return;
    }
    this.runInline(input);
  }

  /**
   * Lista ejecuciones del workspace AUTENTICADO (recientes primero), opcionalmente por estado y/o workflow.
   * Enriquece cada fila con `workflowId` + `workflowName` (resueltos por la versión anclada, deduplicados)
   * para que la UI pueda mostrar y filtrar por workflow. El filtro por workflow se resuelve a las VERSIONES
   * de ese workflow y se aplica en el repo ANTES del límite → correcto en Prisma e InMemory por igual.
   */
  async list(workspaceId: string, opts: { status?: string; limit?: number; workflowId?: string } = {}) {
    // Límite acotado (evita agotar memoria) y estado validado contra el enum (evita queries inválidas).
    const limit = Math.min(Math.max(1, Number(opts.limit ?? 50) || 50), 200);
    const status = opts.status && VALID_STATUSES.includes(opts.status as ExecutionStatus) ? (opts.status as ExecutionStatus) : undefined;
    const workflowId = opts.workflowId?.trim() || undefined;

    // Filtro por workflow → sus versiones (aisla por tenant: solo se resuelve si el workflow es del workspace).
    let workflowVersionIds: string[] | undefined;
    if (workflowId) {
      const wf = await this.p.workflows.get(workflowId);
      if (!wf || wf.workspaceId !== workspaceId) return { workspaceId, executions: [] };
      const versions = await this.p.workflows.listVersions(workflowId);
      workflowVersionIds = versions.map((v) => v.id);
      if (workflowVersionIds.length === 0) return { workspaceId, executions: [] };
    }
    const rows = await this.p.executions.list({ workspaceId, status, limit, workflowVersionIds });

    // Mapa id→nombre de los workflows del workspace (una consulta) + resolución versión→workflowId deduplicada.
    const names = new Map<string, string>();
    for (const w of await this.p.workflows.list(workspaceId)) names.set(w.id, w.name);
    const versionToWf = new Map<string, string | null>();
    const executions = [];
    for (const e of rows) {
      if (!versionToWf.has(e.workflowVersionId)) {
        const v = await this.p.workflows.getVersion(e.workflowVersionId);
        versionToWf.set(e.workflowVersionId, v?.workflowId ?? null);
      }
      const wfId = versionToWf.get(e.workflowVersionId) ?? null;
      executions.push({ ...e, workflowId: wfId, workflowName: wfId ? names.get(wfId) ?? null : null });
    }
    return { workspaceId, executions };
  }

  /** Verifica que una ejecución pertenece al workspace autenticado (404 si no). */
  async assertOwned(id: string, workspaceId: string): Promise<void> {
    const execution = await this.p.executions.get(id);
    assertInWorkspace(execution?.workspaceId, workspaceId, 'Ejecución');
  }

  /**
   * Delta del stream (M9): devuelve SOLO los eventos con `seq > since` de una ejecución del propio
   * tenant. La consola lo sondea con `since = último seq visto` para no re-transferir el historial.
   */
  async listEvents(id: string, workspaceId: string, since = -1) {
    await this.assertOwned(id, workspaceId);
    return { events: await this.p.events.list(id, since) };
  }

  /**
   * Sirve un artefacto de la ejecución (M72): una captura/PDF/descarga que una tool (p. ej. Browser
   * Automation) guardó en el IFileStore durante el run. Aislado por tenant: primero se comprueba que la
   * ejecución es del workspace, y el propio `files.get(workspaceId, ...)` está scoped a ese workspace, así
   * que no se puede leer un fichero de otro espacio ni aunque se acierte el id. 404 si no existe.
   */
  async getFile(id: string, workspaceId: string, fileId: string): Promise<{ name: string; mimeType: string; bytes: Uint8Array }> {
    await this.assertOwned(id, workspaceId);
    const file = await this.p.files.get(workspaceId, fileId);
    if (!file) throw new NotFoundException(`Fichero no encontrado: ${fileId}`);
    return file;
  }

  async get(id: string, workspaceId: string) {
    const execution = await this.p.executions.get(id);
    assertInWorkspace(execution?.workspaceId, workspaceId, 'Ejecución');
    const [nodeRuns, context, reviews, events] = await Promise.all([
      this.p.nodeRuns.list(id),
      this.p.context.load(id),
      this.p.pendingReviews.listByExecution(id),
      // Stream DURABLE (M6): sobrevive reinicios de la API; base del replay determinista.
      this.p.events.list(id),
    ]);
    // Versión ANCLADA de la ejecución (inmutable): el replay se dibuja sobre este grafo exacto.
    const version = execution?.workflowVersionId ? await this.p.workflows.getVersion(execution.workflowVersionId) : null;
    return { executionId: id, execution, version, nodeRuns, context, reviews, events };
  }
}
