import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import {
  getTriggerEvent,
  jiraAccessibleResources,
  listJiraProjects,
  registerJiraWebhook,
  deleteJiraWebhooks,
  type JiraFetch,
  type JiraProject,
} from '@core/sdk-plugins';
import type { ConnectorRecord, TriggerBindingRecord } from '@core/engine';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { assertInWorkspace } from '../tenant/tenant.util';
import { WebhooksService } from '../webhooks/webhooks.service';

/** Adaptador del fetch global de Node al tipo mínimo `JiraFetch` de los helpers. */
const jiraFetch: JiraFetch = (url, init) => fetch(url, init);

/**
 * Triggers sin código (M19): materializa una RECETA («Cuando se crea un ticket de Jira») en un webhook
 * REAL registrado EN el proveedor, para que el usuario no tenga que tocar una URL, un secreto ni la
 * consola de Jira. Reutiliza `WebhooksService` para el webhook interno de ingreso y guarda el binding
 * (con el `remoteId` del webhook creado en Jira) para poder borrarlo/renovarlo después.
 */
@Injectable()
export class TriggersService {
  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    private readonly webhooks: WebhooksService,
  ) {}

  private selfBase(): string {
    return process.env.API_SELF_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`;
  }

  /** Lee el token OAuth del conector (deny-by-default por tenant) y valida que esté conectado. */
  private async connectorToken(connectorId: string, workspaceId: string): Promise<{ token: string; connector: ConnectorRecord }> {
    const connector = await this.p.connectors.getInWorkspace(connectorId, workspaceId);
    if (!connector) throw new NotFoundException('Conector no encontrado.');
    if (connector.status !== 'connected' || !connector.credentialsSecretId) {
      throw new BadRequestException(`El conector «${connector.key}» no está conectado.`);
    }
    const token = await this.p.secrets.get(workspaceId, connector.credentialsSecretId);
    if (!token) throw new BadRequestException('Token del conector no disponible (reconéctalo).');
    return { token, connector };
  }

  /** Resuelve el cloudId: el pasado en params, o el único sitio; si hay varios, exige elegir. */
  private async resolveCloudId(token: string, preferred?: string): Promise<string> {
    if (preferred) return preferred;
    const sites = await jiraAccessibleResources(token, jiraFetch);
    if (sites.length === 0) throw new BadRequestException('Este conector no tiene acceso a ningún sitio de Jira.');
    if (sites.length > 1) throw new BadRequestException('Tienes varios sitios de Jira; indica cuál en «cloudId».');
    return sites[0].id;
  }

  /** Proyectos del sitio Jira para poblar el desplegable del picker. */
  async jiraProjects(connectorId: string, workspaceId: string, cloudId?: string): Promise<{ cloudId: string; projects: JiraProject[] }> {
    const { token } = await this.connectorToken(connectorId, workspaceId);
    const resolved = await this.resolveCloudId(token, cloudId);
    const projects = await listJiraProjects(token, resolved, jiraFetch);
    return { cloudId: resolved, projects };
  }

  async listByWorkflow(workflowId: string, workspaceId: string): Promise<TriggerBindingRecord[]> {
    const wf = await this.p.workflows.get(workflowId);
    assertInWorkspace(wf?.workspaceId, workspaceId, 'Workflow');
    return this.p.triggerBindings.listByWorkflow(workflowId);
  }

  /**
   * Crea la receta: 1) webhook interno (reutiliza WebhooksService.create), 2) registra el webhook EN
   * Jira con la URL de ingreso (secreto en `?token=`), 3) persiste el binding con el `remoteId`. Si el
   * registro en Jira falla, COMPENSA borrando el webhook interno (evita huérfanos).
   */
  async create(
    workflowId: string,
    workspaceId: string,
    input: { eventId: string; connectorId: string; params?: Record<string, unknown> },
  ): Promise<TriggerBindingRecord> {
    const wf = await this.p.workflows.get(workflowId);
    assertInWorkspace(wf?.workspaceId, workspaceId, 'Workflow');

    const def = getTriggerEvent(input.eventId);
    if (!def || def.kind !== 'external' || def.provider !== 'jira') {
      throw new BadRequestException(`Receta no soportada para auto-registro: ${input.eventId}`);
    }
    const params = input.params ?? {};
    const projectKey = typeof params.projectKey === 'string' ? params.projectKey.trim() : '';
    if (!projectKey) throw new BadRequestException('Elige un proyecto de Jira.');

    const { token } = await this.connectorToken(input.connectorId, workspaceId);
    const cloudId = await this.resolveCloudId(token, typeof params.cloudId === 'string' ? params.cloudId : undefined);

    // 1) Webhook interno (exige que el nodo Trigger del grafo sea «webhook»; el picker lo fija).
    const wh = await this.webhooks.create(workflowId, workspaceId, input.eventId);
    const url = `${this.selfBase()}/hooks/${wh.id}?token=${encodeURIComponent(wh.signingSecret)}`;

    // 2) Registrar en Jira. Si falla, compensar borrando el webhook interno.
    let remoteIds: number[];
    try {
      remoteIds = await registerJiraWebhook(
        token,
        cloudId,
        { url, events: def.providerEvents ?? [], jqlFilter: `project = ${projectKey}` },
        jiraFetch,
      );
    } catch (e) {
      await this.webhooks.delete(wh.id, workspaceId).catch(() => undefined);
      const msg = e instanceof Error ? e.message : String(e);
      if (/HTTP 40[13]/.test(msg)) {
        throw new BadRequestException('Jira rechazó el registro. Reautoriza Jira (permiso «gestionar webhooks») y reintenta.');
      }
      throw new BadRequestException(`No se pudo registrar el disparador en Jira: ${msg}`);
    }

    // 3) Persistir el binding.
    return this.p.triggerBindings.create({
      workspaceId,
      workflowId,
      eventId: input.eventId,
      connectorId: input.connectorId,
      webhookId: wh.id,
      remoteId: remoteIds.join(','),
      params: { projectKey, cloudId },
    });
  }

  /** Borra la receta: desregistra en Jira (best-effort) + borra el webhook interno + el binding. */
  async delete(id: string, workspaceId: string): Promise<void> {
    const b = await this.p.triggerBindings.get(id);
    if (!b) return;
    assertInWorkspace(b.workspaceId, workspaceId, 'TriggerBinding');

    if (b.remoteId) {
      try {
        const { token } = await this.connectorToken(b.connectorId, workspaceId);
        const cloudId = typeof b.params.cloudId === 'string' ? b.params.cloudId : '';
        const ids = b.remoteId.split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n));
        if (cloudId && ids.length) await deleteJiraWebhooks(token, cloudId, ids, jiraFetch);
      } catch {
        // Desregistro remoto best-effort: si el conector ya no existe, seguimos limpiando lo local.
      }
    }
    await this.webhooks.delete(b.webhookId, workspaceId).catch(() => undefined);
    await this.p.triggerBindings.delete(id);
  }
}
