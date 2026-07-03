import { Module } from '@nestjs/common';
import { ConnectorsService } from './connectors.service';
import { ConnectorsController, DevOAuthController } from './connectors.controller';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';

// El proveedor OAuth `dev` (auto-aprueba y emite tokens sin verificar identidad) SOLO se registra
// fuera de producción: en prod sería un proveedor OAuth abierto. En prod se usan IdPs reales.
const isProd = process.env.NODE_ENV === 'production';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: isProd ? [ConnectorsController] : [ConnectorsController, DevOAuthController],
  providers: [ConnectorsService],
})
export class ConnectorsModule {}
