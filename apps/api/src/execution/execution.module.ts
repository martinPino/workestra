import { Module } from '@nestjs/common';
import { ExecutionsController } from './executions.controller';
import { ExecutionsService } from './executions.service';
import { ExecutionEventHub } from './execution-event-hub';
import { HumanEscalationController } from './human-escalation.controller';
import { HumanEscalationService } from './human-escalation.service';
import { TelemetryGateway } from './telemetry.gateway';
import { NODE_REGISTRY, buildNodeRegistry } from './node-registry';
import { EXECUTION_QUEUE, createExecutionQueue, RedisEventBridge } from './queue';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: [ExecutionsController, HumanEscalationController],
  providers: [
    ExecutionsService,
    HumanEscalationService,
    ExecutionEventHub,
    TelemetryGateway,
    RedisEventBridge,
    { provide: EXECUTION_QUEUE, useFactory: createExecutionQueue },
    {
      provide: NODE_REGISTRY,
      useFactory: (p: PersistenceBundle) =>
        buildNodeRegistry({ agents: p.agents, memory: p.memory, pendingReviews: p.pendingReviews, connectors: p.connectors, secrets: p.secrets, files: p.files }),
      inject: [PERSISTENCE],
    },
  ],
  exports: [ExecutionsService, ExecutionEventHub],
})
export class ExecutionModule {}
