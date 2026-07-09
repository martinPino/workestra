import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthRateLimitGuard } from '../auth/auth-rate-limit.guard';
import { TeamService } from './team.service';
import { TeamController } from './team.controller';

@Module({
  imports: [AuthModule, RbacModule], // AuthService (issueSession) + RbacService/ScopesGuard
  controllers: [TeamController],
  providers: [TeamService, AuthRateLimitGuard],
})
export class TeamModule {}
