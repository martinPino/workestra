import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Workspace } from '../auth/workspace.decorator';
import { AgentsService } from './agents.service';

@Controller('agents')
export class AgentsController {
  constructor(private readonly svc: AgentsService) {}

  @Get()
  list(@Workspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Get(':id')
  get(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.get(id, workspaceId);
  }

  @Post()
  create(@Body() body: Parameters<AgentsService['create']>[0], @Workspace() workspaceId: string) {
    return this.svc.create(body, workspaceId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: Parameters<AgentsService['update']>[1],
    @Workspace() workspaceId: string,
  ) {
    return this.svc.update(id, body, workspaceId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.remove(id, workspaceId);
  }
}
