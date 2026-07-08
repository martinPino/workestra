import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Role } from '@core/contracts';
import { RegisterSchema, LoginSchema } from '@core/contracts';
import { AuthService, EmailTakenError, type JwtPayload } from './auth.service';
import { Public } from './public.decorator';

interface DevTokenBody {
  sub?: string;
  email?: string;
  role?: Role;
  workspaceId?: string;
}

/**
 * ¿Está activo el minter de tokens de DEV? Solo fuera de producción y cuando AUTH_MODE es 'dev' (por
 * defecto en local). En prod se despliega AUTH_MODE=local → el minter queda cerrado y la sesión se emite
 * únicamente por /auth/login|register. Doble barrera con NODE_ENV para que un olvido de AUTH_MODE no lo abra.
 */
function devMinterEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return (process.env.AUTH_MODE ?? 'dev') === 'dev';
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Registro con email+contraseña (M73): crea el usuario y su propio workspace (OWNER) y devuelve la sesión.
   */
  @Public()
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
