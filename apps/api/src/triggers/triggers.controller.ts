import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Public } from '../auth/public.decorator';
import { Workspace } from '../auth/workspace.decorator';
import { TriggersService } from './triggers.service';

/** Recetas de disparador de un workflow (triggers sin código, M19). Protegido por RBAC + tenant. */
@Controller('workflows/:workflowId/triggers')
export class TriggersController {
  constructor(private readonly svc: TriggersService) {}

  @Post()
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  create(
    @Param('workflowId') workflowId: string,
    @Body() body: { eventId: string; connectorId: string; params?: Record<string, unknown> },
    @Workspace() workspaceId: string,
  ) {
    return this.svc.create(workflowId, workspaceId, body);
  }

  @Get()
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:read')
  list(@Param('workflowId') workflowId: string, @Workspace() workspaceId: string) {
    return this.svc.listByWorkflow(workflowId, workspaceId);
  }
}

/** Borrado de una receta por id (desregistra en el proveedor + limpia lo local). */
@Controller('triggers')
export class TriggerAdminController {
  constructor(private readonly svc: TriggersService) {}

  @Delete(':id')
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  remove(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.delete(id, workspaceId);
  }
}

/** Proyectos de Jira accesibles con un conector (para poblar el desplegable del picker). */
@Controller('connectors/:connectorId/jira-projects')
export class JiraProjectsController {
  constructor(private readonly svc: TriggersService) {}

  @Get()
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:read')
  list(@Param('connectorId') connectorId: string, @Query('cloudId') cloudId: string | undefined, @Workspace() workspaceId: string) {
    return this.svc.jiraProjects(connectorId, workspaceId, cloudId);
  }
}

/**
 * Ingreso PÚBLICO de eventos de Jira (M19): URL estable por conector `POST /hooks/jira/:connectorId?token=…`.
 * Sin JWT; autenticado por el token en el query (los webhooks dinámicos de Jira no admiten cabeceras). El
 * servicio enruta por el contenido del evento al flujo(s) correcto(s). Devuelve 202.
 */
@Public()
@Controller('hooks/jira')
export class JiraHooksController {
  constructor(private readonly svc: TriggersService) {}

  @Post(':connectorId')
  @HttpCode(202)
  async ingest(
    @Param('connectorId') connectorId: string,
    @Req() req: { rawBody?: Buffer; body?: unknown },
    @Query('token') token?: string,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    let payload: unknown = {};
    try {
      payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } catch {
      payload = {};
    }
    return this.svc.ingestJiraEvent(connectorId, token, payload);
  }
}

/**
 * Ingreso PÚBLICO de webhooks de Sentry (M80): la Sentry App (Public Integration) POSTea a `/hooks/sentry` con
 * la firma `Sentry-Hook-Signature` (HMAC del cuerpo con el Client Secret) y `Sentry-Hook-Resource: issue`. El
 * servicio verifica la firma y enruta por «org/proyecto» al flujo(s). Devuelve 202.
 */
@Public()
@Controller('hooks/sentry')
export class SentryHooksController {
  constructor(private readonly svc: TriggersService) {}

  @Post()
  @HttpCode(202)
  async ingest(
    @Req() req: { rawBody?: Buffer; body?: unknown },
    @Headers('sentry-hook-signature') signature?: string,
    @Headers('sentry-hook-resource') resource?: string,
  ) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    let payload: unknown = {};
    try {
      payload = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } catch {
      payload = {};
    }
    return this.svc.ingestSentryEvent(rawBody, signature, resource, payload);
  }
}
