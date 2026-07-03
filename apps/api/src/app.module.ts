import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { RbacModule } from './rbac/rbac.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { TenantMiddleware } from './tenant/tenant.middleware';
import { PersistenceModule } from './persistence/persistence.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { ExecutionModule } from './execution/execution.module';
import { AgentsModule } from './agents/agents.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { SchedulesModule } from './schedules/schedules.module';
import { ConnectorsModule } from './connectors/connectors.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PersistenceModule,
    RbacModule,
    AuthModule,
    WorkflowsModule,
    AgentsModule,
    ExecutionModule,
    WebhooksModule,
    SchedulesModule,
    ConnectorsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Auth GLOBAL: toda ruta exige JWT salvo las marcadas @Public(). El workspace del token es la
    // fuente de verdad del tenant para todo el scoping/ownership posterior.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
