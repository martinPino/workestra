import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Public } from '../auth/public.decorator';
import { Workspace } from '../auth/workspace.decorator';
import { WebhooksService, UnauthorizedSignature } from './webhooks.service';

/** Gestión de webhooks de un workflow (protegido por RBAC + tenant). */
@Controller('workflows/:workflowId/webhooks')
export class WebhooksController {
  constructor(private readonly svc: WebhooksService) {}

  @Post()
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  create(@Param('workflowId') workflowId: string, @Body() body: { event?: string }, @Workspace() workspaceId: string) {
    return this.svc.create(workflowId, workspaceId, body?.event);
  }

  @Get()
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:read')
  list(@Param('workflowId') workflowId: string, @Workspace() workspaceId: string) {
    return this.svc.listByWorkflow(workflowId, workspaceId);
  }
}

/** Borrado de un webhook por id (protegido). */
@Controller('webhooks')
export class WebhookAdminController {
  constructor(private readonly svc: WebhooksService) {}

  @Delete(':id')
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  remove(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.delete(id, workspaceId);
  }
}

/**
 * Ingreso PÚBLICO de webhooks: `POST /hooks/:token`. No lleva JWT. Autenticación por CUALQUIERA de:
 *  - FIRMA HMAC-SHA256 del cuerpo con el secreto (`x-agentflow-signature`), o
 *  - el secreto presentado como TOKEN (`x-agentflow-token`), para clientes que no pueden firmar HMAC
 *    (p. ej. Jira Automation / Zapier, que sí pueden enviar un header estático).
 * Devuelve 202 con el executionId; auth inválida ⇒ 401.
 */
@Public()
@Controller('hooks')
export class HooksController {
  constructor(private readonly svc: WebhooksService) {}

  @Post(':token')
  @HttpCode(202)
  async ingest(
    @Param('token') token: string,
    @Req() req: { rawBody?: Buffer; body?: unknown },
    @Headers('x-agentflow-signature') signature?: string,
    @Headers('x-agentflow-token') authToken?: string,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    try {
      return await this.svc.ingest(token, rawBody, signature, authToken);
    } catch (e) {
      if (e instanceof UnauthorizedSignature) throw new UnauthorizedException(e.message);
      throw e;
    }
  }
}
