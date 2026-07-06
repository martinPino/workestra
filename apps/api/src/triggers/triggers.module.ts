import { Module } from '@nestjs/common';
import { TriggersService } from './triggers.service';
import { TriggersController, TriggerAdminController, JiraProjectsController, JiraHooksController } from './triggers.controller';
import { ExecutionModule } from '../execution/execution.module';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [ExecutionModule, AuthModule, RbacModule],
  controllers: [TriggersController, TriggerAdminController, JiraProjectsController, JiraHooksController],
  providers: [TriggersService],
})
export class TriggersModule {}
