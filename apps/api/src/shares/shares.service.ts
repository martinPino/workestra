import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '../http/common';
import { createHash, randomBytes } from 'node:crypto';
import type {
  Agent,
  CreateShareRequest,
  CreateShareResponse,
  PortableWorkflowDoc,
  ShareReport,
  SharePreviewResponse,
  WorkflowGraph,
} from '@core/contracts';
import { sanitizeWorkflowForShare } from '@core/sdk-plugins';
import { runInSystemMode } from '@core/infra/postgres';
import type { ShareRecord } from '@core/engine';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/bundle';
import { assertInWorkspace } from '../tenant/tenant.util';

/**
 * Compartir un workflow por enlace (M85). El servicio orquesta las piezas que ya existen (el sanitizador de
 * `@core/sdk-plugins` y el repo `p.shares`) y guarda TRES invariantes de seguridad:
 *
 *  1. El `workspaceId` sale SIEMPRE del JWT verificado (lo inyecta el controller con @Workspace()), nunca del
 *     cuerpo/params. El dueño de un share es su workspace; no hay forma de crear/leer/revocar en nombre de otro.
 *  2. Lo que se persiste ya está SANITIZADO (el sanitizador quita secretos y referencias de cuenta); la lectura
 *     pública devuelve ese snapshot inmutable, nunca el workflow vivo ni el hash del token.
 *  3. El token en claro se muestra UNA vez (al crear) y no se guarda: en reposo solo vive su sha256.
 */

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Token opaco del enlace. Se muestra una vez y jamás se persiste (solo su hash). */
const newToken = (): string => randomBytes(24).toString('base64url');
/**
 * Base del front para construir el enlace público. MISMA convención que las invitaciones de equipo (M74,
 * `team.service.ts`): reutilizamos `APP_URL` para que ambos enlaces apunten al mismo web app.
 */
const appBase = (): string => (process.env.APP_URL ?? 'https://appweb-production-1a37.up.railway.app').replace(/\/+$/, '');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRY_DAYS = 30;

@Injectable()
export class SharesService {
  constructor(@Inject(PERSISTENCE) private readonly p: PersistenceBundle) {}

  /**
   * Crea (o solo previsualiza, con `dryRun`) el enlace de compartir de un workflow del workspace.
   * `getOwned` garantiza que el workflow es del tenant autenticado (404 si no).
   */
  async createShare(workflowId: string, workspaceId: string, userId: string, dto: CreateShareRequest): Promise<CreateShareResponse> {
    const wf = await this.getOwned(workflowId, workspaceId);
    const { doc, report } = await this.buildDoc(wf.name, wf.graph, workspaceId);

    // `dryRun` (por defecto): solo se enseña el informe de qué viajaría; NO se escribe nada.
    if (dto.dryRun) return { report };

    // Fail-closed: si hay sospechas de secreto de baja confianza sin aceptar a conciencia, no se crea el enlace.
    // Se «acepta» un item por su `location`; basta con que quede uno sin reconocer para bloquear.
    const ack = new Set(dto.acknowledgeBlocking ?? []);
    const unacknowledged = report.blocking.filter((b) => !ack.has(b.location));
    if (unacknowledged.length > 0) {
      throw new UnprocessableEntityException({
        message: 'El flujo contiene contenido que parece una credencial. Revísalo o acéptalo explícitamente antes de compartir.',
        report,
      });
    }

    const token = newToken();
    // `expiresInDays === null` ⇒ enlace sin caducidad; ausente ⇒ 30 días por defecto.
    const expiresAt = dto.expiresInDays === null ? null : new Date(Date.now() + (dto.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * DAY_MS).toISOString();

    await this.p.shares.create({
      workspaceId,
      workflowId,
      // OJO: el nombre SANITIZADO (`doc.name`), no `wf.name`. La preview pública devuelve `sourceName`, así que
      // el nombre crudo del flujo llegaría al enlace sin pasar por el escáner —justo la fuga que el E2E pilló—.
      // Guardando el redactado, el secreto ni siquiera se persiste en la fila del share.
      sourceName: doc.name,
      tokenHash: sha256(token),
      snapshot: doc,
      report,
      redactionCount: report.redactionCount,
      createdByUserId: userId,
      expiresAt,
    });

    return { report, token, url: `${appBase()}/import/${token}`, expiresAt };
  }

  /**
   * Lectura PÚBLICA del enlace (sin sesión ni tenant). El share se localiza por el hash del token —único
   * globalmente— y se devuelve el snapshot YA sanitizado; nunca el hash ni datos de otro workspace.
   */
  async preview(token: string): Promise<SharePreviewResponse> {
    const share = await this.liveShare(token);
    return {
      name: share.sourceName,
      doc: share.snapshot as PortableWorkflowDoc,
      report: share.report as ShareReport,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
    };
  }

  /**
   * Registra una importación del enlace (quien importa está autenticado, pero NO es el dueño del share). El
   * alta real del workflow ocurre en el cliente (reusa el «instalar» del marketplace con el JWT del importador);
   * aquí solo se sube el contador.
   *
   * TODO EN MODO SISTEMA —incluida la BÚSQUEDA—: la fila del share es de OTRO workspace (el del que compartió).
   * Con el tenant del importador activo, RLS filtraría esa fila y `liveShare` daría 404 a CUALQUIER importación
   * cross-workspace (que es el 99% de los casos): rompería la feature entera en prod. El token es globalmente
   * único, así que buscar sin aislamiento es seguro —igual que la preview pública—. El contador se sube
   * idempotente por workspace: reintentar o llamar en bucle desde la misma cuenta no lo infla.
   */
  async importShare(token: string, importerWorkspaceId: string): Promise<{ imported: true; token: string }> {
    await runInSystemMode(async () => {
      const share = await this.liveShare(token);
      await this.p.shares.bumpImport(share.id, importerWorkspaceId);
    });
    return { imported: true, token };
  }

  /**
   * Revoca un enlace. A un NO dueño se le responde 404 (no 403): no confirmamos la existencia de un share
   * fuera de su workspace. El dueño se comprueba comparando el `workspaceId` del share con el del JWT.
   */
  async revoke(token: string, workspaceId: string): Promise<{ revoked: true }> {
    const share = await this.p.shares.findByTokenHash(sha256(token));
    if (!share || share.workspaceId !== workspaceId) throw new NotFoundException('Enlace no encontrado.');
    await this.p.shares.revoke(share.id);
    return { revoked: true };
  }

  /**
   * Enlaces del workspace, en una vista SEGURA para que el dueño los gestione: sin `tokenHash` (permitiría
   * adivinar el enlace) ni `snapshot` (pesado; ya se ve en la preview pública). Solo metadatos.
   */
  async list(workspaceId: string) {
    const rows = await this.p.shares.listByWorkspace(workspaceId);
    return rows.map((s) => ({
      id: s.id,
      sourceName: s.sourceName,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      importCount: s.importCount,
    }));
  }

  /** Carga un workflow verificando que pertenece al workspace autenticado (404 si no). Igual que WorkflowsService. */
  private async getOwned(id: string, workspaceId: string) {
    const wf = await this.p.workflows.get(id);
    assertInWorkspace(wf?.workspaceId, workspaceId, 'Workflow');
    return wf!;
  }

  /**
   * Sanitiza el workflow a su forma portable. Resuelve los agentes referenciados por los DOS sitios donde un
   * nodo puede apuntarlos (`node.agentId` y `node.config.agentId`), acotados al workspace (`getInWorkspace`): un
   * id que apuntara fuera del tenant simplemente no resuelve y se omite.
   */
  private async buildDoc(name: string, graph: WorkflowGraph, workspaceId: string): Promise<{ doc: PortableWorkflowDoc; report: ShareReport }> {
    const ids = new Set<string>();
    for (const n of graph.nodes) {
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      if (typeof n.agentId === 'string') ids.add(n.agentId);
      if (typeof cfg.agentId === 'string') ids.add(cfg.agentId);
    }
    const agents: Agent[] = [];
    for (const id of ids) {
      const agent = await this.p.agents.getInWorkspace(id, workspaceId);
      if (agent) agents.push(agent);
    }
    return sanitizeWorkflowForShare({ workflow: { name, graph }, agents });
  }

  /** Localiza un share VIGENTE por el token en claro: 404 si no existe, está revocado o ha caducado. */
  private async liveShare(token: string): Promise<ShareRecord> {
    const share = await this.p.shares.findByTokenHash(sha256(token));
    if (!share || share.revokedAt || (share.expiresAt && Date.parse(share.expiresAt) < Date.now())) {
      throw new NotFoundException('El enlace no es válido o ha caducado.');
    }
    return share;
  }
}
