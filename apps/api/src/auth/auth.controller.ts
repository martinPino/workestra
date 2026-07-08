import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Role } from '@core/contracts';
import { RegisterSchema, LoginSchema } from '@core/contracts';
import { AuthService, EmailTakenError, type JwtPayload } from './auth.service';
import { Public } from './public.decorator';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';

interface DevTokenBody {
  sub?: string;
  email?: string;
  role?: Role;
  workspaceId?: string;
}

/**
 * ¿Está activo el minter de tokens de DEV? FAIL-CLOSED: cerrado salvo que AUTH_MODE sea EXPLÍCITAMENTE
 * 'dev' (sin valor por defecto) y NO estemos en producción. Los despliegues (staging/preview/prod) NO fijan
 * AUTH_MODE → el minter queda cerrado aunque olviden NODE_ENV=production, evitando que cualquiera acuñe un
 * OWNER de otro tenant. El arranque LOCAL (`pnpm --filter @app/api dev`) sí fija AUTH_MODE=dev.
 */
function devMinterEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.AUTH_MODE === 'dev';
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Registro con email+contraseña (M73): crea el usuario y su propio workspace (OWNER) y devuelve la sesión.
   */
  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('register')
  async register(@Body() body: unknown) {
    const parsed = RegisterSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    try {
      return await this.auth.register(parsed.data);
    } catch (e) {
      if (e instanceof EmailTakenError) throw new ConflictException('Ese email ya está registrado. Inicia sesión.');
      throw e;
    }
  }

  /** Inicio de sesión con email+contraseña (M73). 401 genérico si email o contraseña no coinciden. */
  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('login')
  async login(@Body() body: unknown) {
    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    const session = await this.auth.login(parsed.data);
    if (!session) throw new UnauthorizedException('Email o contraseña incorrectos.');
    return session;
  }

  /**
   * DEV ONLY: emite un JWT de pruebas para CUALQUIER workspace/rol. Cerrado en producción y cuando
   * AUTH_MODE != 'dev' (sería un minter de tokens abierto: cualquiera acuñaría un OWNER de otro tenant).
   */
  @Public()
  @Post('token')
  token(@Body() body: DevTokenBody) {
    if (!devMinterEnabled()) {
      throw new ForbiddenException('El token de desarrollo está deshabilitado. Usa /auth/login o /auth/register.');
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
