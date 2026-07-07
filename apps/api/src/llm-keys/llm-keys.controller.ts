import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Workspace } from '../auth/workspace.decorator';
import { LlmKeysService } from './llm-keys.service';

/**
 * Claves de IA propias del workspace (BYOK, M35). Solo se listan enmascaradas; el valor nunca se devuelve.
 * Requiere `workflow:write` (configurar la IA del workspace).
 */
@Controller('llm-keys')
@UseGuards(ScopesGuard)
@RequireScopes('workflow:write')
export class LlmKeysController {
  constructor(private readonly svc: LlmKeysService) {}

  @Get()
  list(@Workspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post()
  set(@Body() body: { provider: string; apiKey: string }, @Workspace() workspaceId: string) {
    return this.svc.set(workspaceId, body?.provider ?? '', body?.apiKey ?? '');
  }

  @Delete(':provider')
  remove(@Param('provider') provider: string, @Workspace() workspaceId: string) {
    return this.svc.remove(workspaceId, provider);
  }
}
