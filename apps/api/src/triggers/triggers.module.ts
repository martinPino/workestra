import { Module } from '@nestjs/common';
import { TriggersService } from './triggers.service';
import { TriggersController, TriggerAdminController, JiraProjectsController } from './triggers.controller';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [WebhooksModule, AuthModule, RbacModule],
  controllers: [TriggersController, TriggerAdminController, JiraProjectsController],
  providers: [TriggersService],
})
export class TriggersModule {}
