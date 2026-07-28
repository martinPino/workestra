import { Module } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { TriggersModule } from '../triggers/triggers.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { RbacModule } from '../rbac/rbac.module';
import { LlmKeysModule } from '../llm-keys/llm-keys.module';

@Module({
  // TriggersModule: al borrar un flujo, desregistra sus disparadores de Jira (best-effort).
  // SchedulesModule: al PUBLICAR, reconcilia el sondeo de Google Drive desde el nodo Trigger (M53).
  // RbacModule: provee RbacService a ScopesGuard, usado por @Delete(':id') con @RequireScopes.
  // LlmKeysModule: WorkflowsService construye el router con las claves BYOK del workspace (M35).
  imports: [TriggersModule, SchedulesModule, RbacModule, LlmKeysModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService], // reutilizado por el módulo MCP (M32)
})
export class WorkflowsModule {}
