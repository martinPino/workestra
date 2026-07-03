import { Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { ScopesGuard } from './scopes.guard';

@Module({
  providers: [RbacService, ScopesGuard],
  exports: [RbacService, ScopesGuard],
})
export class RbacModule {}
