import { Body, Controller, ForbiddenException, Get, Post, Req } from '@nestjs/common';
import type { Role } from '@core/contracts';
import { AuthService, type JwtPayload } from './auth.service';
import { Public } from './public.decorator';

interface DevTokenBody {
  sub?: string;
  email?: string;
  role?: Role;
  workspaceId?: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * DEV ONLY: emite un JWT de pruebas para CUALQUIER workspace/rol. Se DESHABILITA en producción
   * (sería un minter de tokens abierto: cualquiera acuñaría un OWNER de otro tenant). En prod la
   * autenticación la emite el IdP vía OIDC (Authorization Code).
   */
  @Public()
  @Post('token')
  token(@Body() body: DevTokenBody) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('El token de desarrollo está deshabilitado en producción (usa OIDC).');
    }
    return {
      accessToken: this.auth.issueDevToken({
        sub: body.sub ?? 'user_dev',
        email: body.email ?? 'owner@acme.dev',
        role: body.role ?? 'OWNER',
        workspaceId: body.workspaceId ?? 'ws_dev',
      }),
    };
  }

  // `me` ya no necesita @UseGuards: el guard global exige JWT (no es @Public).
  @Get('me')
  me(@Req() req: { user: JwtPayload }) {
    return req.user;
  }
}
