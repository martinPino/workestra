import { Injectable, ForbiddenException } from '@nestjs/common';
import type { Role } from '@core/contracts';
import { can } from './rbac.policy';

@Injectable()
export class RbacService {
  can(role: Role, scope: string): boolean {
    return can(role, scope);
  }

  /** Lanza ForbiddenException si el rol no tiene el scope. Deny-by-default. */
  assert(role: Role, scope: string): void {
    if (!this.can(role, scope)) {
      throw new ForbiddenException(`Falta el scope requerido: ${scope}`);
    }
  }
}
