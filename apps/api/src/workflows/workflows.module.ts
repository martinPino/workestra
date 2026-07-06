import { Module } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { TriggersModule } from '../triggers/triggers.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  // TriggersModule: al borrar un flujo, desregistra sus disparadores de Jira (best-effort).
  // RbacModule: provee RbacService a ScopesGuard, usado por @Delete(':id') con @RequireScopes.
  imports: [TriggersModule, RbacModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
})
export class WorkflowsModule {}
