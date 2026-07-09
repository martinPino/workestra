import type { PrismaClient } from '@prisma/client';
import type { IAuthRepository, AuthAccount } from '@core/engine';
import type { Role } from '@core/contracts';
import { InMemoryIdentityStore, type IdentitySeed } from './identity-store';

/** Genera un slug único de workspace a partir del email (para el @@unique([organizationId, slug])). */
function slugFromEmail(email: string): string {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  return base.slice(0, 40);
}

/**
 * Acceso a usuarios/pertenencias en memoria (M73) — para dev/tests sin Postgres. Delega en un
 * InMemoryIdentityStore COMPARTIDO con el repo de equipo (para que una invitación aceptada sea visible al
 * login). Acepta un array de seed (crea su propio store) o un store ya existente para compartirlo.
 */
export class InMemoryAuthRepository implements IAuthRepository {
  private readonly store: InMemoryIdentityStore;

  constructor(seedOrStore: IdentitySeed[] | InMemoryIdentityStore = []) {
    this.store = seedOrStore instanceof InMemoryIdentityStore ? seedOrStore : new InMemoryIdentityStore(seedOrStore);
  }

  /** El store subyacente, para que el repo de equipo comparta la misma identidad in-memory. */
  get identityStore(): InMemoryIdentityStore {
    return this.store;
  }

  async findByEmail(email: string): Promise<AuthAccount | null> {
    return this.store.findByEmail(email);
  }

  async createAccount(input: { email: string; passwordHash: string; name: string }): Promise<AuthAccount> {
    return this.store.createAccount(input);
  }
}

/**
 * Acceso a usuarios/pertenencias durable (Prisma, M73). `createAccount` hace User+Organization+Workspace+
 * Membership(OWNER) en UNA transacción (todo o nada). `findByEmail` resuelve la pertenencia primaria: la
 * primera membership del usuario que tenga workspace (preferimos OWNER). El email se guarda/consulta en
 * minúsculas para que la unicidad sea insensible a mayúsculas.
 */
export class PrismaAuthRepository implements IAuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByEmail(email: string): Promise<AuthAccount | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { memberships: { where: { workspaceId: { not: null } } } },
    });
    if (!user) return null;
    // Pertenencia primaria: preferimos una OWNER; si no, la primera con workspace.
    const memberships = user.memberships as Array<{ organizationId: string; workspaceId: string | null; role: Role; disabledAt: Date | null }>;
    const m = memberships.find((x) => x.role === 'OWNER') ?? memberships[0];
    if (!m || !m.workspaceId) return null; // usuario sin workspace válido → no puede iniciar sesión
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      passwordHash: user.passwordHash,
      workspaceId: m.workspaceId,
      organizationId: m.organizationId,
      role: m.role,
      disabledAt: m.disabledAt ?? null,
    };
  }

  async createAccount(input: { email: string; passwordHash: string; name: string }): Promise<AuthAccount> {
    const email = input.email.toLowerCase();
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email } });
      if (existing) throw new Error('EMAIL_TAKEN');
      const org = await tx.organization.create({ data: { name: `${input.name || email}'s org`, slug: `${slugFromEmail(email)}-${Date.now().toString(36)}` } });
      const workspace = await tx.workspace.create({ data: { organizationId: org.id, name: 'Mi espacio', slug: 'default' } });
      const user = await tx.user.create({ data: { email, passwordHash: input.passwordHash, name: input.name } });
      await tx.membership.create({ data: { userId: user.id, organizationId: org.id, workspaceId: workspace.id, role: 'OWNER' } });
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        workspaceId: workspace.id,
        organizationId: org.id,
        role: 'OWNER' as Role,
      };
    });
  }
}
