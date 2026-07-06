import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { Workspace } from '../auth/workspace.decorator';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { WorkflowsService } from './workflows.service';

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly svc: WorkflowsService) {}

  @Post()
  create(@Body() body: { name: string; graph?: unknown }, @Workspace() workspaceId: string) {
    return this.svc.create(body, workspaceId);
  }

  // «Construir con IA» (M29): describe → la IA devuelve {name, graph}. El cliente crea el workflow con eso.
  // Guardado con workflow:write: genera vía LLM (operación con coste), no debe poder lanzarla un VIEWER.
  @Post('generate')
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  generate(@Body() body: { prompt: string }, @Workspace() workspaceId: string) {
    return this.svc.generate(body?.prompt ?? '', workspaceId);
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

  @Delete(':id')
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:delete') // acción destructiva (borra todo el historial): solo ADMIN/OWNER
  remove(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.remove(id, workspaceId);
  }
}
