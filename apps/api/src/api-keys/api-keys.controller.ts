import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Workspace } from '../auth/workspace.decorator';
import { ApiKeyAuthService } from './api-key-auth.service';
import type { ApiKeyPrincipal } from './api-key.util';

/**
 * Gestión de claves de API por workspace (M32). Mintear una clave concede acceso al workspace, así que
 * solo ADMIN/OWNER pueden (scope `apikey:manage`). La clave en claro se devuelve UNA vez al crearla.
 */
@Controller('api-keys')
@UseGuards(ScopesGuard)
@RequireScopes('apikey:manage')
export class ApiKeysController {
  constructor(private readonly svc: ApiKeyAuthService) {}

  @Post()
  create(@Body() body: { label?: string }, @Req() req: { user: ApiKeyPrincipal }) {
    return this.svc.create(req.user, body?.label ?? 'MCP');
  }

  @Get()
  list(@Workspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Delete(':id')
  revoke(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.revoke(id, workspaceId);
  }
}
