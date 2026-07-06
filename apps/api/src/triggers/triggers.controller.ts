import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
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
