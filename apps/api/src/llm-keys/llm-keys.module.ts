import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { LlmKeysService } from './llm-keys.service';
import { LlmKeysController } from './llm-keys.controller';

/**
 * Claves de IA propias por workspace (BYOK, M35). Importa RbacModule (el controller usa ScopesGuard).
 * Exporta LlmKeysService para que WorkflowsService construya el router con las claves del workspace.
 */
@Module({
  imports: [RbacModule],
  controllers: [LlmKeysController],
  providers: [LlmKeysService],
  exports: [LlmKeysService],
})
export class LlmKeysModule {}
