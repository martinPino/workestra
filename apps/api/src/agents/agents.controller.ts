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

  // Verifica un servidor MCP (M43/M45): se conecta (con su credencial si está conectado) y lista sus tools.
  // Sirve para avisar en la UI si faltan credenciales (401/403) o no responde, como el warning de n8n.
  @Post('mcp/verify')
  verifyMcp(@Body() body: { url: string; serverId?: string }, @Workspace() workspaceId: string) {
    return this.svc.verifyMcp(body?.url ?? '', workspaceId, body?.serverId);
  }

  // «Conectar» un servidor MCP (M45): guarda su credencial cifrada para activarlo. «Desconectar» la borra.
  @Post('mcp/connect')
  connectMcp(@Body() body: { serverId: string; token: string }, @Workspace() workspaceId: string) {
    return this.svc.connectMcp(workspaceId, body?.serverId ?? '', body?.token ?? '');
  }

  @Delete('mcp/connect/:serverId')
  disconnectMcp(@Param('serverId') serverId: string, @Workspace() workspaceId: string) {
    return this.svc.disconnectMcp(workspaceId, serverId);
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
