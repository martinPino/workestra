import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { JwtPayload } from '../auth/auth.service';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/bundle';

/**
 * Administrador de PLATAFORMA (M84): quien puede ver la analítica cruzando TODOS los workspaces.
 *
 * La lista de correos vive en `ANALYTICS_ADMIN_EMAILS`, no en la base de datos: si fuese una columna,
 * cualquiera con acceso a la BD —o un fallo en un endpoint de equipo— podría concederse el permiso de
 * leer los datos de todos los clientes.
 *
 * PERO un correo NO es una identidad: es una cadena que cualquiera puede reclamar registrándose. Si en
 * la lista hay una dirección que todavía no tiene cuenta, quien se registre con ella se lleva el permiso.
 * Por eso los correos se resuelven UNA VEZ al arrancar contra las cuentas que YA existen, y a partir de
 * ahí se compara el id de usuario, que nadie puede elegir. Registrarse después con un correo de la lista
 * no concede nada.
 *
 * Falla CERRADO por todos lados: sin variable, sin cuentas resueltas o si la resolución falla, no hay
 * administradores de plataforma y el panel global no existe para nadie.
 */
@Injectable()
export class PlatformAdminService implements OnModuleInit {
  private readonly log = new Logger('analytics');
  /** Ids resueltos al arrancar. Vacío = nadie. */
  private admins = new Set<string>();

  constructor(@Inject(PERSISTENCE) private readonly p: PersistenceBundle) {}

  async onModuleInit(): Promise<void> {
    const emails = parseAllowlist(process.env.ANALYTICS_ADMIN_EMAILS);
    if (emails.length === 0) {
      this.log.log('sin ANALYTICS_ADMIN_EMAILS: el panel de plataforma queda desactivado');
      return;
    }
    for (const email of emails) {
      try {
        const account = await this.p.auth.findByEmail(email);
        if (account?.id) {
          this.admins.add(account.id);
        } else {
          // Se dice en voz alta: una dirección sin cuenta es justo la que alguien podría reclamar, y
          // quien opera esto tiene que enterarse de que ese permiso no está concedido.
          this.log.warn(`ANALYTICS_ADMIN_EMAILS incluye «${email}», que no tiene cuenta: no concede acceso`);
        }
      } catch (e) {
        this.log.error(`no se pudo resolver «${email}»: el permiso queda SIN conceder. ${(e as Error).message}`);
      }
    }
    this.log.log(`panel de plataforma: ${this.admins.size} administrador(es) resuelto(s) de ${emails.length} correo(s)`);
  }

  /** ¿Este usuario es administrador de plataforma? Por id, nunca por correo. */
  isAdmin(userId?: string): boolean {
    return !!userId && this.admins.has(userId);
  }
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly svc: PlatformAdminService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    if (!this.svc.isAdmin(req.user?.sub)) {
      // Mismo mensaje que un recurso inexistente: a quien no es admin no se le confirma que el panel existe.
      throw new ForbiddenException('No disponible.');
    }
    return true;
  }
}

/** Normaliza la variable de entorno a correos en minúsculas. Exportada para poder probarla. */
export function parseAllowlist(raw?: string): string[] {
  return (raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
