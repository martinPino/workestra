import { Hono } from 'hono';
import { RegisterSchema, LoginSchema } from '@core/contracts';
import type { Role } from '@core/contracts';
import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '../common';
import { rateLimit, emailSubject } from '../rate-limit.middleware';
import { EmailTakenError, AccountDisabledError } from '../../auth/auth.service';
import type { RouterEnv } from './types';

/**
 * ¿Está activo el minter de tokens de DEV? FAIL-CLOSED: cerrado salvo que AUTH_MODE sea EXPLÍCITAMENTE
 * 'dev' y NO estemos en producción. Los despliegues no fijan AUTH_MODE → queda cerrado aunque olviden
 * NODE_ENV, evitando que cualquiera acuñe un OWNER de otro tenant.
 */
function devMinterEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.AUTH_MODE === 'dev';
}

/** Rutas de sesión: port de `AuthController`. Las tres primeras son públicas y van con rate-limit. */
export function authRouter(): Hono<RouterEnv> {
  const r = new Hono<RouterEnv>();

  r.post('/register', rateLimit({ subject: emailSubject }), async (c) => {
    const parsed = RegisterSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    try {
      return c.json(await c.get('services').auth.register(parsed.data));
    } catch (e) {
      if (e instanceof EmailTakenError) throw new ConflictException('Ese email ya está registrado. Inicia sesión.');
      throw e;
    }
  });

  r.post('/login', rateLimit({ subject: emailSubject }), async (c) => {
    const parsed = LoginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    let session;
    try {
      session = await c.get('services').auth.login(parsed.data);
    } catch (e) {
      if (e instanceof AccountDisabledError) {
        throw new ForbiddenException('Tu cuenta está desactivada. Contacta con un administrador del equipo.');
      }
      throw e;
    }
    // 401 genérico: no se distingue «email no existe» de «contraseña incorrecta», para no filtrar
    // qué cuentas existen.
    if (!session) throw new UnauthorizedException('Email o contraseña incorrectos.');
    return c.json(session);
  });

  r.post('/token', async (c) => {
    if (!devMinterEnabled()) {
      throw new ForbiddenException('El token de desarrollo está deshabilitado. Usa /auth/login o /auth/register.');
    }
    type DevTokenBody = { sub?: string; email?: string; role?: Role; workspaceId?: string };
    const b: DevTokenBody = await c.req.json<DevTokenBody>().catch(() => ({}));
    return c.json({
      accessToken: await c.get('services').auth.issueDevToken({
        sub: b.sub ?? 'user_dev',
        email: b.email ?? 'owner@acme.dev',
        role: b.role ?? 'OWNER',
        workspaceId: b.workspaceId ?? 'ws_dev',
      }),
    });
  });

  // No es pública: el middleware ya exigió sesión, así que devuelve el principal verificado.
  r.get('/me', (c) => c.json(c.get('user')));

  return r;
}
