import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@core/contracts';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  workspaceId: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  /** DEV ONLY: emite un token de pruebas. En producción lo emite el IdP (OIDC). */
  issueDevToken(p: JwtPayload): string {
    return this.jwt.sign(p);
  }

  verify(token: string): JwtPayload {
    return this.jwt.verify<JwtPayload>(token);
  }
}
