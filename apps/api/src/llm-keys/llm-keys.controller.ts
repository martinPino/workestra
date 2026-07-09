import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Workspace } from '../auth/workspace.decorator';
import { LlmKeysService } from './llm-keys.service';

/**
 * Claves de IA propias del workspace (BYOK, M35). Solo se listan enmascaradas; el valor nunca se devuelve.
 * Son credenciales COMPARTIDAS del workspace: listarlas (enmascaradas) va con `workflow:read`, pero
 * añadir/quitar una clave es gestión de credenciales del espacio → `apikey:manage` (ADMIN/OWNER), no EDITOR.
 */
@Controller('llm-keys')
@UseGuards(ScopesGuard)
export class LlmKeysController {
  constructor(private readonly svc: LlmKeysService) {}

  @Get()
  @RequireScopes('workflow:read')
  list(@Workspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post()
  @RequireScopes('apikey:manage')
  set(@Body() body: { provider: string; apiKey: string }, @Workspace() workspaceId: string) {
    return this.svc.set(workspaceId, body?.provider ?? '', body?.apiKey ?? '');
  }

  @Delete(':provider')
  @RequireScopes('apikey:manage')
  remove(@Param('provider') provider: string, @Workspace() workspaceId: string) {
    return this.svc.remove(workspaceId, provider);
  }
}
