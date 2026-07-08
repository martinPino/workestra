import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * Rate-limit en memoria para los endpoints de credenciales (M73): frena fuerza bruta de contraseñas y la
 * creación masiva de cuentas/orgs/workspaces. Ventana deslizante por IP+ruta. Es una barrera de defensa en
 * profundidad, no la única: en producción el borde (proxy/PaaS) debe imponer su propio límite. Sin
 * dependencias (una sola instancia singleton mantiene el mapa); barre entradas viejas de forma oportunista.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs = 60_000;
  private readonly max = 10; // intentos por IP y ruta por minuto

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; ip?: string; path?: string; url?: string; socket?: { remoteAddress?: string } }>();
    const fwd = req.headers['x-forwarded-for'];
    const ip = (fwd?.split(',')[0] || req.ip || req.socket?.remoteAddress || 'unknown').trim();
    const key = `${req.path ?? req.url ?? ''}:${ip}`;
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      throw new HttpException('Demasiados intentos. Espera un minuto e inténtalo de nuevo.', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.sweep(now); // evita crecimiento ilimitado del mapa
    return true;
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) {
      const fresh = v.filter((t) => now - t < this.windowMs);
      if (fresh.length === 0) this.hits.delete(k);
      else this.hits.set(k, fresh);
    }
  }
}
