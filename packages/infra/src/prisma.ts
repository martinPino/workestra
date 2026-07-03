import { PrismaClient } from '@prisma/client';
import { currentWorkspace } from './workspace-context';

export interface PrismaClientOptions {
  /**
   * Activa la 2ª barrera RLS (M10): envuelve cada operación en una transacción que primero fija
   * `app.current_workspace` (SET LOCAL) desde el contexto de tenant, de modo que las políticas de
   * `prisma/rls.sql` filtran a ese workspace aunque el chequeo de aplicación fallara. Exige conectar
   * con un rol SIN superusuario/BYPASSRLS (agentflow_app); ver `prisma/roles.sql`.
   */
  rls?: boolean;
  /** URL de conexión (rol restringido agentflow_app cuando `rls`); por defecto la del schema. */
  url?: string;
}

/** Factoría del cliente Prisma. Cada app gestiona su ciclo de vida (connect/disconnect). */
export function createPrismaClient(opts: PrismaClientOptions = {}): PrismaClient {
  const base = new PrismaClient(opts.url ? { datasources: { db: { url: opts.url } } } : undefined);
  if (!opts.rls) return base;
  // Sin tenant en el contexto (worker/seed/migraciones) NO fija nada ⇒ modo SISTEMA (la política
  // permite cuando el ajuste es NULL). Con tenant, el SET LOCAL vive en la MISMA transacción que la
  // consulta, así RLS filtra a `app.current_workspace`. No hay `$transaction` anidado en los
  // adaptadores, por lo que este envoltorio por-operación es seguro.
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        const ws = currentWorkspace();
        if (!ws) return query(args);
        const [, result] = await base.$transaction([
          base.$executeRaw`SELECT set_config('app.current_workspace', ${ws}, true)`,
          query(args),
        ]);
        return result;
      },
    },
  }) as unknown as PrismaClient;
}

export { PrismaClient };
