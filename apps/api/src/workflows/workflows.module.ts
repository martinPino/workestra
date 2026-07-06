import { Module } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { TriggersModule } from '../triggers/triggers.module';

@Module({
  imports: [TriggersModule], // al borrar un flujo, desregistra sus disparadores de Jira (best-effort)
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
})
export class WorkflowsModule {}
