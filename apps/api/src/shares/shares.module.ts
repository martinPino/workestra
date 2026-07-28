import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthRateLimitGuard } from '../auth/auth-rate-limit.guard';
import { SharesService } from './shares.service';
import { SharesController } from './shares.controller';

@Module({
  // RbacModule es CRÍTICO: provee RbacService a ScopesGuard (usado por @Post('workflows/:id/share') con
  // @RequireScopes). Sin él, el guard no resuelve su dependencia y el contenedor DI de Nest revienta al
  // arrancar en Railway (crash-loop) — algo que `pnpm verify` NO detecta porque no bootea el DI.
  // PersistenceModule es @Global (el bundle ya estaría disponible), pero se importa explícito por claridad.
  imports: [PersistenceModule, RbacModule],
  controllers: [SharesController],
  providers: [SharesService, AuthRateLimitGuard],
})
export class SharesModule {}
