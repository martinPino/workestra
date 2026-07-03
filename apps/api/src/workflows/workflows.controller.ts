import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { Workspace } from '../auth/workspace.decorator';
import { WorkflowsService } from './workflows.service';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly svc: WorkflowsService) {}

  @Post()
  create(@Body() body: { name: string; graph?: unknown }, @Workspace() workspaceId: string) {
    return this.svc.create(body, workspaceId);
  }

  @Get()
  list(@Workspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Get(':id')
  get(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.get(id, workspaceId);
  }

  @Put(':id/graph')
  saveGraph(@Param('id') id: string, @Body() body: unknown, @Workspace() workspaceId: string) {
    return this.svc.saveGraph(id, body, workspaceId);
  }

  @Post(':id/publish')
  publish(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.publish(id, workspaceId);
  }

  @Get(':id/versions')
  versions(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.listVersions(id, workspaceId);
  }
}
