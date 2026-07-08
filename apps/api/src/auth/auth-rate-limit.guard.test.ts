import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';

/** ExecutionContext falso con una petición mínima (ip + ruta). */
function ctxFor(ip: string, path = '/auth/login'): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers: {}, ip, path }) }),
  } as unknown as ExecutionContext;
}

describe('AuthRateLimitGuard (M73)', () => {
  it('permite hasta 10 intentos por IP y ruta, y bloquea el 11º con 429', () => {
    const guard = new AuthRateLimitGuard();
    const ctx = ctxFor('1.2.3.4');
    for (let i = 0; i < 10; i++) expect(guard.canActivate(ctx)).toBe(true);
    let status = 0;
    try {
      guard.canActivate(ctx);
    } catch (e) {
      status = (e as { getStatus(): number }).getStatus();
    }
    expect(status).toBe(429);
  });

  it('aísla el contador por IP y por ruta', () => {
    const guard = new AuthRateLimitGuard();
    for (let i = 0; i < 10; i++) guard.canActivate(ctxFor('9.9.9.9', '/auth/login'));
    // Otra IP no está limitada…
    expect(guard.canActivate(ctxFor('8.8.8.8', '/auth/login'))).toBe(true);
    // …y la misma IP en otra ruta tampoco.
    expect(guard.canActivate(ctxFor('9.9.9.9', '/auth/register'))).toBe(true);
  });
});
