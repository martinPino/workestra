import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Workspace } from '../auth/workspace.decorator';
import { SchedulesService } from './schedules.service';

/** Gestión de triggers programados de un workflow (protegido por RBAC + tenant). */
@Controller('workflows/:workflowId/schedules')
export class SchedulesController {
  constructor(private readonly svc: SchedulesService) {}

  @Post()
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  create(@Param('workflowId') workflowId: string, @Body() body: { cron?: string; everyMs?: number }, @Workspace() workspaceId: string) {
    return this.svc.create(workflowId, workspaceId, body);
  }

  @Get()
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:read')
  list(@Param('workflowId') workflowId: string, @Workspace() workspaceId: string) {
    return this.svc.listByWorkflow(workflowId, workspaceId);
  }
}

/** Borrado de un schedule por id (protegido). */
@Controller('schedules')
export class ScheduleAdminController {
  constructor(private readonly svc: SchedulesService) {}

  @Delete(':id')
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  remove(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.delete(id, workspaceId);
  }
}
