import { Logger } from '../http/common';

import { type PersistenceBundle } from '../persistence/bundle';

/**
 * Administrador de PLATAFORMA (M84): quien puede ver la analítica cruzando TODOS los workspaces.
 *
 * La lista de correos vive en `ANALYTICS_ADMIN_EMAILS`, no en la base de datos: si fuese una columna,
 * cualquiera con acceso a la BD —o un fallo en un endpoint de equipo— podría concederse el permiso de
 * leer los datos de todos los clientes.
 *
 * PERO un correo NO es una identidad: es una cadena que cualquiera puede reclamar registrándose. Si en
 * la lista hay una dirección que todavía no tiene cuenta, quien se registre con ella se lleva el permiso.
 * Por eso los correos se resuelven contra las cuentas que YA existen y a partir de ahí se compara el id
 * de usuario, que nadie puede elegir. Registrarse después con un correo de la lista no concede nada.
 *
 * Falla CERRADO por todos lados: sin variable, sin cuentas resueltas o si la resolución falla, no hay
 * administradores de plataforma y el panel global no existe para nadie.
 *
 * ── Por qué esto cambió al migrar ──────────────────────────────────────────────────────────────────
 * En Nest la resolución iba en `onModuleInit`: una vez, al arrancar el proceso. En Workers NO HAY
 * arranque — cada isolate nace con la petición y muere, y no hay ciclo de vida de módulo donde
 * colgarse. Resolver en cada petición sería una consulta extra por request; resolver «al arrancar» no
 * existe. Así que se resuelve PEREZOSAMENTE la primera vez que hace falta en el isolate y se cachea
 * ahí: el coste es una consulta por isolate, y la propiedad de seguridad —comparar por id, nunca por
 * correo— se conserva intacta.
 */
export class PlatformAdminService {
  private readonly log = new Logger('analytics');
  /** Ids resueltos. `null` = todavía no se ha mirado en este isolate. */
  private admins: Set<string> | null = null;

  constructor(private readonly p: PersistenceBundle) {}

  /**
   * ¿Este usuario es administrador de plataforma? Por id, nunca por correo.
   *
   * Es `async` porque la primera llamada del isolate resuelve la lista contra la base de datos. Quien
   * la invoca DEBE esperarla: sin `await`, una promesa se evalúa como truthy y el permiso se concedería
   * a cualquiera.
   */
  async isAdmin(userId?: string): Promise<boolean> {
    if (!userId) return false;
    return (await this.resolved()).has(userId);
  }

  /** Resuelve (una vez por isolate) los correos de la allowlist a ids de cuentas existentes. */
  private async resolved(): Promise<Set<string>> {
    if (this.admins) return this.admins;

    const emails = parseAllowlist(process.env.ANALYTICS_ADMIN_EMAILS);
    if (emails.length === 0) {
      this.log.log('sin ANALYTICS_ADMIN_EMAILS: el panel de plataforma queda desactivado');
      return (this.admins = new Set());
    }

    const admins = new Set<string>();
    let failed = false;
    for (const email of emails) {
      try {
        const account = await this.p.auth.findByEmail(email);
        if (account?.id) {
          admins.add(account.id);
        } else {
          // Se dice en voz alta: una dirección sin cuenta es justo la que alguien podría reclamar, y
          // quien opera esto tiene que enterarse de que ese permiso no está concedido.
          this.log.warn(`ANALYTICS_ADMIN_EMAILS incluye «${email}», que no tiene cuenta: no concede acceso`);
        }
      } catch (e) {
        failed = true;
        this.log.error(`no se pudo resolver «${email}»: el permiso queda SIN conceder. ${(e as Error).message}`);
      }
    }

    // Un fallo de BD NO se cachea: esta petición ya falla cerrado (el id no está en el set), pero
    // congelar el resultado dejaría al administrador fuera hasta que el isolate se recicle, por un
    // error que puede ser de un segundo. Sin cachear, la siguiente petición reintenta.
    if (failed) return admins;

    this.log.log(`panel de plataforma: ${admins.size} administrador(es) resuelto(s) de ${emails.length} correo(s)`);
    return (this.admins = admins);
  }
}

export function parseAllowlist(raw?: string): string[] {
  return (raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
