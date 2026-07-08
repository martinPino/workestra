import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-only-change-me',
      signOptions: { expiresIn: '1h' },
    }),
  ],
  controllers: [AuthController],
  // AuthRateLimitGuard como provider → una única instancia (mantiene su ventana en memoria entre peticiones).
  providers: [AuthService, JwtAuthGuard, AuthRateLimitGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
