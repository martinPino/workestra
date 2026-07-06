import { Module } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { WebhooksController, WebhookAdminController, HooksController } from './webhooks.controller';
import { ExecutionModule } from '../execution/execution.module';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [ExecutionModule, AuthModule, RbacModule],
  controllers: [WebhooksController, WebhookAdminController, HooksController],
  providers: [WebhooksService],
  exports: [WebhooksService], // TriggersModule (M19) reutiliza la creación de webhooks internos.
})
export class WebhooksModule {}
