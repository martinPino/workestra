import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { ApiKeyAuthService } from './api-key-auth.service';
import { ApiKeysController } from './api-keys.controller';

/**
 * Claves de API por workspace (M32). Importa RbacModule porque el controller usa ScopesGuard
 * (regla anti-crash-loop). Exporta ApiKeyAuthService para reutilizarlo desde el módulo MCP.
 */
@Module({
  imports: [RbacModule],
  controllers: [ApiKeysController],
  providers: [ApiKeyAuthService],
  exports: [ApiKeyAuthService],
})
export class ApiKeysModule {}
