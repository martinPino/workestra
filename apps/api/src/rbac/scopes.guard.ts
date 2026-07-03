import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@core/contracts';
import { SCOPES_KEY } from './scopes.decorator';
import { RbacService } from './rbac.service';

/** Aplica los scopes declarados con @RequireScopes contra el rol del usuario autenticado. */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbac: RbacService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [ctx.getHandler(), ctx.getClass()]) ?? [];
    if (required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{ user?: { role?: Role } }>();
    const role = req.user?.role;
    if (!role) throw new ForbiddenException('No autenticado o sin rol asignado.');

    for (const scope of required) this.rbac.assert(role, scope);
    return true;
  }
}
