import { Injectable, Inject, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  TRIGGER_EVENTS,
  getTriggerEvent,
  jiraAccessibleResources,
  listJiraProjects,
  listJiraWebhookIds,
  registerJiraWebhooks,
  deleteJiraWebhooks,
  type JiraFetch,
  type JiraProject,
} from '@core/sdk-plugins';
import type { TriggerBindingRecord } from '@core/engine';
import { setCurrentWorkspace } from '@core/infra';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { assertInWorkspace } from '../tenant/tenant.util';
import { ExecutionsService } from '../execution/executions.service';

/** Adaptador del fetch global con timeout de 10s (un endpoint de Jira colgado no debe colgar la petición). */
const jiraFetch: JiraFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });

const stableTokenKey = (connectorId: string) => `jira-hook:${connectorId}`;

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
}

/**
 * Triggers sin código (M19): materializa una RECETA («Cuando se crea un ticket de Jira») en webhooks REALES
 * registrados EN Jira, sin que el usuario toque una URL, un secreto ni la consola de Jira.
 *
 * Jira solo permite UNA URL por usuario, así que TODAS las recetas de un conector comparten una URL estable
 * `/hooks/jira/<connectorId>?token=<secreto>` y se enrutan por el CONTENIDO del evento (proyecto + tipo) al
 * flujo correcto. Cada cambio RECONCILIA: borra todos los webhooks del usuario (limpia huérfanos) y
 * re-registra los bindings activos bajo la URL estable.
 */
@Injectable()
export class TriggersService {
  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    private readonly executions: ExecutionsService,
  ) {}

  private selfBase(): string {
    return process.env.API_SELF_URL ?? `http://localhost:${process.env.API_PORT ?? 3001}`;
  }

  /** Lee el token OAuth del conector (deny-by-default por tenant) y valida que esté conectado. */
  private async connectorToken(connectorId: string, workspaceId: string): Promise<string> {
    const connector = await this.p.connectors.getInWorkspace(connectorId, workspaceId);
    if (!connector) throw new NotFoundException('Conector no encontrado.');
    if (connector.status !== 'connected' || !connector.credentialsSecretId) {
      throw new BadRequestException(`El conector «${connector.key}» no está conectado.`);
    }
    const token = await this.p.secrets.get(workspaceId, connector.credentialsSecretId);
    if (!token) throw new BadRequestException('Token del conector no disponible (reconéctalo).');
    return token;
  }

  /** Resuelve el cloudId: el pasado en params, o el único sitio; si hay varios, exige elegir. */
  private async resolveCloudId(token: string, preferred?: string): Promise<string> {
    if (preferred) return preferred;
    const sites = await jiraAccessibleResources(token, jiraFetch);
    if (sites.length === 0) throw new BadRequestException('Este conector no tiene acceso a ningún sitio de Jira.');
    if (sites.length > 1) throw new BadRequestException('Tienes varios sitios de Jira; indica cuál en «cloudId».');
    return sites[0].id;
  }

  /** Token estable por conector (una URL por usuario en Jira): se genera una vez y se reutiliza. */
  private async ensureStableToken(connectorId: string, workspaceId: string): Promise<string> {
    const key = stableTokenKey(connectorId);
    let tok = await this.p.secrets.get(workspaceId, key);
    if (!tok) {
      tok = `whsec_${randomBytes(24).toString('base64url')}`;
      await this.p.secrets.set(workspaceId, key, tok);
    }
    return tok;
  }

  /**
   * Reconcilia Jira con nuestros bindings activos del conector: borra TODOS los webhooks del usuario (limpia
   * huérfanos y evita el conflicto de «una URL por usuario») y re-registra los activos bajo la URL estable,
   * guardando el remoteId de cada uno. Idempotente: dejar el estado remoto = nuestro estado local.
   */
  private async reconcile(connectorId: string, workspaceId: string, oauthToken: string, cloudId: string): Promise<void> {
    const stableToken = await this.ensureStableToken(connectorId, workspaceId);
    const url = `${this.selfBase()}/hooks/jira/${connectorId}?token=${encodeURIComponent(stableToken)}`;

    const existing = await listJiraWebhookIds(oauthToken, cloudId, jiraFetch);
    const active = (await this.p.triggerBindings.listByConnector(connectorId)).filter((b) => b.active);
    const entries = active.map((b) => ({
      events: getTriggerEvent(b.eventId)?.providerEvents ?? [],
      jqlFilter: `project = ${String(b.params.projectKey ?? '')}`,
    }));

    // Sin webhooks deseados: solo limpiar los existentes.
    if (!entries.length) {
      if (existing.length) await deleteJiraWebhooks(oauthToken, cloudId, existing, jiraFetch);
      return;
    }

    // REGISTRAR-ANTES-DE-BORRAR: nunca dejar a Jira sin webhooks si el registro falla. Como todos usan la
    // MISMA URL estable, registrar el set nuevo convive con los viejos (breve ventana de duplicados) hasta
    // que borramos los viejos. Solo si el registro choca por «una URL por usuario» (huérfano con OTRA URL)
    // limpiamos primero y reintentamos. Otros errores (Jira caído, 403) se propagan SIN borrar nada.
    let ids: Array<number | null>;
    try {
      ids = await registerJiraWebhooks(oauthToken, cloudId, url, entries, jiraFetch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/single URL|one URL/i.test(msg) && existing.length) {
        await deleteJiraWebhooks(oauthToken, cloudId, existing, jiraFetch);
        ids = await registerJiraWebhooks(oauthToken, cloudId, url, entries, jiraFetch);
        for (let i = 0; i < active.length; i++) await this.p.triggerBindings.setRemoteId(active[i].id, ids[i] != null ? String(ids[i]) : null);
        return;
      }
      throw e; // los webhooks previos siguen vivos
    }
    // Registro OK: ahora sí borramos los viejos (best-effort) y guardamos los ids nuevos.
    if (existing.length) await deleteJiraWebhooks(oauthToken, cloudId, existing, jiraFetch).catch(() => undefined);
    for (let i = 0; i < active.length; i++) {
      await this.p.triggerBindings.setRemoteId(active[i].id, ids[i] != null ? String(ids[i]) : null);
    }
  }

  /** Proyectos del sitio Jira para poblar el desplegable del picker. */
  async jiraProjects(connectorId: string, workspaceId: string, cloudId?: string): Promise<{ cloudId: string; projects: JiraProject[] }> {
    const token = await this.connectorToken(connectorId, workspaceId);
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
   * Crea la receta: persiste el binding y RECONCILIA (registra el/los webhook(s) en Jira bajo la URL estable).
   * Si Jira falla, COMPENSA borrando el binding nuevo y re-reconciliando (best-effort) para no dejar rotos los
   * demás disparadores del conector.
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

    const token = await this.connectorToken(input.connectorId, workspaceId);
    const cloudId = await this.resolveCloudId(token, typeof params.cloudId === 'string' ? params.cloudId : undefined);

    const binding = await this.p.triggerBindings.create({
      workspaceId,
      workflowId,
      eventId: input.eventId,
      connectorId: input.connectorId,
      webhookId: `jira:${input.connectorId}`, // marcador: se enruta por la URL estable del conector, no por webhook interno
      remoteId: null,
      params: { projectKey, cloudId },
    });
    try {
      await this.reconcile(input.connectorId, workspaceId, token, cloudId);
    } catch (e) {
      await this.p.triggerBindings.delete(binding.id).catch(() => undefined);
      await this.reconcile(input.connectorId, workspaceId, token, cloudId).catch(() => undefined); // restaura los demás
      const msg = e instanceof Error ? e.message : String(e);
      if (/HTTP 40[13]/.test(msg)) {
        throw new BadRequestException('Jira rechazó el registro. Reautoriza Jira (permiso «gestionar webhooks») y reintenta.');
      }
      throw new BadRequestException(`No se pudo registrar el disparador en Jira: ${msg}`);
    }
    return (await this.p.triggerBindings.get(binding.id)) ?? binding;
  }

  /** Borra la receta: quita el binding y reconcilia Jira (desregistra el suyo, deja los demás). Best-effort. */
  async delete(id: string, workspaceId: string): Promise<void> {
    const b = await this.p.triggerBindings.get(id);
    if (!b) return;
    assertInWorkspace(b.workspaceId, workspaceId, 'TriggerBinding');
    await this.p.triggerBindings.delete(id);
    try {
      const token = await this.connectorToken(b.connectorId, workspaceId);
      const cloudId = String(b.params.cloudId ?? '');
      if (cloudId) await this.reconcile(b.connectorId, workspaceId, token, cloudId);
    } catch {
      // Best-effort: si el conector ya no existe o Jira falla, el binding local ya está borrado.
    }
  }

  /**
   * Ingreso PÚBLICO de eventos de Jira (URL estable por conector). Verifica el token, y enruta el evento al
   * flujo(s) correcto(s) según el CONTENIDO: tipo de evento (`webhookEvent`) + clave de proyecto. Arranca una
   * ejecución por cada binding que coincida.
   */
  async ingestJiraEvent(connectorId: string, presentedToken: string | undefined, payload: unknown): Promise<{ started: string[] }> {
    const bindings = (await this.p.triggerBindings.listByConnector(connectorId)).filter((b) => b.active);
    // Respuesta UNIFORME para no revelar existencia/estado del conector a un caller sin el secreto: sin
    // bindings o con token inválido → 401 idéntico (no distinguimos «no existe» de «token incorrecto»).
    if (!bindings.length) throw new UnauthorizedException('Token inválido.');

    // El ingreso es @Public (sin tenant en contexto); fijamos el workspace del binding para RLS/ejecución.
    const workspaceId = bindings[0].workspaceId;
    setCurrentWorkspace(workspaceId);

    const stableToken = await this.p.secrets.get(workspaceId, stableTokenKey(connectorId));
    if (!stableToken || !tokenMatches(presentedToken, stableToken)) throw new UnauthorizedException('Token inválido.');

    const rec = asRecord(payload);
    const webhookEvent = String(rec.webhookEvent ?? '');
    const def = TRIGGER_EVENTS.find((e) => e.providerEvents?.includes(webhookEvent));
    const issue = asRecord(rec.issue);
    const fields = asRecord(issue.fields);
    const projectKey = String(asRecord(fields.project).key ?? '');

    // Contexto AMIGABLE: exponemos los campos del ticket en la raíz (`{{ticket.key}}`, `{{ticket.summary}}`)
    // además del payload crudo — así los pasos del flujo (p. ej. mover el ticket) no tienen que navegar la
    // estructura completa del evento de Jira.
    const ticket = {
      key: String(issue.key ?? ''),
      summary: String(fields.summary ?? ''),
      description: fields.description ?? '',
      project: projectKey,
      event: webhookEvent,
      webhook: payload,
    };

    const matches = bindings.filter((b) => def && b.eventId === def.id && String(b.params.projectKey ?? '') === projectKey);
    const started: string[] = [];
    const seen = new Set<string>(); // dedupe: un evento arranca cada flujo UNA vez (aunque haya recetas duplicadas)
    for (const b of matches) {
      if (seen.has(b.workflowId)) continue;
      seen.add(b.workflowId);
      const r = await this.executions.start(
        b.workflowId,
        b.workspaceId,
        { ticket, variables: { trigger: 'webhook', connectorId, issueKey: ticket.key, payload } },
        'webhook',
      );
      started.push(r.executionId);
    }
    return { started };
  }
}

/** Compara el token presentado con el esperado en tiempo constante. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
