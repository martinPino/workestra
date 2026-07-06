import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { WebhookRecord } from '@core/engine';
import { setCurrentWorkspace } from '@core/infra';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { assertInWorkspace } from '../tenant/tenant.util';
import { triggerEventOf } from '../workflows/trigger.util';
import { ExecutionsService } from '../execution/executions.service';

const secretKeyFor = (webhookId: string) => `webhook:${webhookId}:signing`;

export interface CreatedWebhook {
  id: string;
  url: string;
  event: string;
  /** Secreto de firma en CLARO: se muestra UNA sola vez (después solo vive cifrado). */
  signingSecret: string;
}

/**
 * Webhooks entrantes (M7): un workflow expone endpoints `/hooks/<id>` firmados con HMAC-SHA256. El
 * secreto de firma se genera al crear y se guarda CIFRADO en el `ISecretStore`; solo se devuelve en
 * claro en la respuesta de creación. Al recibir una petición válida se arranca una ejecución del
 * workflow ligado inyectando el payload en el contexto.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @Inject(PERSISTENCE) private readonly p: PersistenceBundle,
    private readonly executions: ExecutionsService,
  ) {}

  async create(workflowId: string, workspaceId: string, event = 'webhook'): Promise<CreatedWebhook> {
    const wf = await this.p.workflows.get(workflowId);
    assertInWorkspace(wf?.workspaceId, workspaceId, 'Workflow');
    // El nodo Trigger gobierna la integración: solo se crean webhooks si su evento es `webhook`.
    if (triggerEventOf(wf?.graph) !== 'webhook') {
      throw new BadRequestException(
        `El Trigger de este workflow es «${triggerEventOf(wf?.graph)}», no «webhook». Cámbialo en el editor para crear webhooks.`,
      );
    }

    const signingSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    // 1) Crear el registro para obtener el id (que hace de token de ingreso).
    const created = await this.p.webhooks.create({ workspaceId, workflowId, event, url: '', signingSecretKey: '' });
    // 2) Derivar url y clave del secreto a partir del id, persistir el secreto CIFRADO y fijar la url.
    const signingSecretKey = secretKeyFor(created.id);
    await this.p.secrets.set(workspaceId, signingSecretKey, signingSecret);
    const url = `/hooks/${created.id}`;
    await this.p.webhooks.setUrlAndSecret(created.id, url, signingSecretKey);

    return { id: created.id, url, event, signingSecret };
  }

  async listByWorkflow(workflowId: string, workspaceId: string): Promise<Array<Omit<WebhookRecord, 'signingSecretKey'>>> {
    const wf = await this.p.workflows.get(workflowId);
    assertInWorkspace(wf?.workspaceId, workspaceId, 'Workflow');
    const rows = await this.p.webhooks.listByWorkflow(workflowId);
    // Nunca exponemos la clave/valor del secreto en el listado.
    return rows.map(({ signingSecretKey: _omit, ...rest }) => rest);
  }

  async delete(id: string, workspaceId: string): Promise<void> {
    const wh = await this.p.webhooks.get(id);
    if (!wh) return;
    assertInWorkspace(wh.workspaceId, workspaceId, 'Webhook');
    // Borra el webhook PRIMERO: así deja de ser invocable de inmediato; si el borrado del secreto
    // fallara luego, queda un secreto huérfano (inofensivo) en vez de un webhook sin firma válida.
    await this.p.webhooks.delete(id);
    await this.p.secrets.delete(wh.workspaceId, wh.signingSecretKey);
  }

  /** Firma canónica de un cuerpo (para pruebas/clientes): hex de HMAC-SHA256. */
  static sign(rawBody: Buffer, signingSecret: string): string {
    return createHmac('sha256', signingSecret).update(rawBody).digest('hex');
  }

  /**
   * Recibe una petición de webhook: valida la firma HMAC contra el secreto cifrado y, si es válida,
   * arranca una ejecución del workflow ligado con el payload en el contexto. Devuelve el executionId.
   */
  async ingest(
    webhookId: string,
    rawBody: Buffer,
    signature: string | undefined,
    presentedToken?: string,
  ): Promise<{ executionId: string; status: string }> {
    const wh = await this.p.webhooks.get(webhookId);
    if (!wh || !wh.active) throw new NotFoundException('Webhook no encontrado o inactivo.');

    // Endurecimiento RLS (M10): la ruta es @Public (sin tenant en el contexto), así que la búsqueda
    // por token corrió en modo-sistema. Ya conocido el dueño, fijamos el workspace para que TODO lo
    // que sigue (secreto, arranque de ejecución, node_runs, eventos) corra tenant-scoped bajo RLS.
    setCurrentWorkspace(wh.workspaceId);

    const signingSecret = await this.p.secrets.get(wh.workspaceId, wh.signingSecretKey);
    if (!signingSecret) throw new NotFoundException('Secreto de firma no disponible.');

    // Autenticación: HMAC del cuerpo (`x-agentflow-signature`) O el secreto presentado como token
    // (`x-agentflow-token`, para clientes que no pueden firmar HMAC, p. ej. Jira Automation/Zapier).
    if (!this.verify(rawBody, signature, signingSecret) && !this.verifyToken(presentedToken, signingSecret)) {
      // Error 401 lo lanza el controlador; aquí señalamos el fallo de autenticación.
      throw new UnauthorizedSignature();
    }

    let payload: unknown = {};
    try {
      payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } catch {
      payload = { raw: rawBody.toString('utf8') };
    }

    // Contexto AMIGABLE: exponemos key/summary/description del ticket en la raíz, soportando tanto un payload
    // PLANO ({key,summary,description}, p. ej. una Automation rule de Jira) como el evento COMPLETO de Jira
    // ({issue:{key,fields:{summary}}}). Así `{{ticket.key}}` funciona igual que en el ingreso de recetas M19,
    // sea cual sea el disparador. `ticket.webhook` sigue siendo el payload crudo (compatibilidad hacia atrás).
    const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const issue = rec.issue && typeof rec.issue === 'object' ? (rec.issue as Record<string, unknown>) : {};
    const fields = issue.fields && typeof issue.fields === 'object' ? (issue.fields as Record<string, unknown>) : {};
    const ticket = {
      key: String(rec.key ?? issue.key ?? ''),
      summary: String(rec.summary ?? fields.summary ?? ''),
      description: rec.description ?? fields.description ?? '',
      webhook: payload,
    };
    // El ingreso es público (autenticado por HMAC/token); la ejecución se ancla al workspace del webhook.
    // `triggerType: 'webhook'` queda grabado de forma durable → la tabla de Ejecuciones lo distingue del manual.
    const result = await this.executions.start(
      wh.workflowId,
      wh.workspaceId,
      { ticket, variables: { trigger: 'webhook', webhookId, issueKey: ticket.key, payload } },
      'webhook',
    );
    return { executionId: result.executionId, status: result.status };
  }

  private verify(rawBody: Buffer, signature: string | undefined, signingSecret: string): boolean {
    if (!signature) return false;
    const expected = WebhooksService.sign(rawBody, signingSecret);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Auth alternativa (bearer): el secreto presentado tal cual, comparado en tiempo constante. */
  private verifyToken(presented: string | undefined, signingSecret: string): boolean {
    if (!presented) return false;
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(signingSecret, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** Marca un fallo de verificación de firma (el controlador lo traduce a 401). */
export class UnauthorizedSignature extends Error {
  constructor() {
    super('Firma de webhook inválida.');
    this.name = 'UnauthorizedSignature';
  }
}
