import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { RbacModule } from '../rbac/rbac.module';
import { LlmKeysModule } from '../llm-keys/llm-keys.module';

@Module({
  // RbacModule: provee RbacService a ScopesGuard, usado por @Post('chat') con @RequireScopes('agent:write').
  // LlmKeysModule: AgentsService construye el router LLM con las claves BYOK del workspace (M35/M68).
  imports: [RbacModule, LlmKeysModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService], // reutilizado por el módulo MCP (M32)
})
export class AgentsModule {}
