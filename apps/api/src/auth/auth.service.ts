import { Inject, Injectable } from '../http/common';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@core/contracts';
import type { RegisterDto, LoginDto } from '@core/contracts';
import { hashPassword, verifyPassword } from '@core/infra';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  workspaceId: string;
}

/** Perfil de sesión que ve el cliente (sin el hash de contraseña). */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  workspaceId: string;
}

export interface SessionResult {
  accessToken: string;
  user: SessionUser;
}

/** Se lanza cuando el email ya está registrado (el controller lo mapea a 409). */
export class EmailTakenError extends Error {
  constructor() {
    super('EMAIL_TAKEN');
  }
}

/** Se lanza cuando la cuenta está «cerrada» (M74): contraseña correcta pero acceso desactivado (403). */
export class AccountDisabledError extends Error {
  constructor() {
    super('ACCOUNT_DISABLED');
  }
}

// El token de SESIÓN vive más que el de dev (1h) para no obligar a re-login cada hora sin tabla de refresh.
const SESSION_TTL = '7d';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(PERSISTENCE) private readonly persistence: PersistenceBundle,
  ) {}

  /** DEV ONLY: emite un token de pruebas para cualquier workspace/rol. Gateado en el controller. */
  issueDevToken(p: JwtPayload): string {
    return this.jwt.sign(p);
  }

  verify(token: string): JwtPayload {
    return this.jwt.verify<JwtPayload>(token);
  }

  /**
   * Alta con email+contraseña (M73): hashea la contraseña (scrypt), crea usuario + su propia
   * organización/workspace + membership OWNER (atómico) y devuelve la sesión. `sub` del JWT es el id
   * REAL del usuario y `role`/`workspaceId` salen de la membership, no del cliente.
   */
  async register(dto: RegisterDto): Promise<SessionResult> {
    const existing = await this.persistence.auth.findByEmail(dto.email);
    if (existing) throw new EmailTakenError();
    const passwordHash = await hashPassword(dto.password);
    let account;
    try {
      account = await this.persistence.auth.createAccount({ email: dto.email, passwordHash, name: dto.name });
    } catch (e) {
      // Carrera: dos altas del mismo email a la vez → la unicidad de BD lanza; lo tratamos como 409.
      if (e instanceof Error && (e.message === 'EMAIL_TAKEN' || /unique|P2002/i.test(e.message))) throw new EmailTakenError();
      throw e;
    }
    return this.issueSession(account);
  }

  /**
   * Login con email+contraseña (M73). Devuelve `null` si el email no existe o la contraseña no coincide
   * (mismo resultado para no filtrar qué emails existen). Verificación en tiempo constante (scrypt).
   */
  async login(dto: LoginDto): Promise<SessionResult | null> {
    const account = await this.persistence.auth.findByEmail(dto.email);
    if (!account) {
      // Trabajo señuelo: hashea igualmente para no dar una pista de tiempo de que el email no existe.
      await verifyPassword(dto.password, 'scrypt$16384$8$1$AAAA$AAAA');
      return null;
    }
    const ok = await verifyPassword(dto.password, account.passwordHash);
    if (!ok) return null;
    // Cuenta cerrada por un admin (M74): contraseña correcta pero acceso revocado → 403 explícito.
    if (account.disabledAt) throw new AccountDisabledError();
    return this.issueSession(account);
  }

  /** Firma un JWT de sesión (7d) para una cuenta ya resuelta. Lo usan login, registro y aceptar invitación. */
  issueSession(account: { id: string; email: string; name: string; role: Role; workspaceId: string }): SessionResult {
    const payload: JwtPayload = { sub: account.id, email: account.email, role: account.role, workspaceId: account.workspaceId };
    const accessToken = this.jwt.sign(payload, { expiresIn: SESSION_TTL });
    return { accessToken, user: { id: account.id, email: account.email, name: account.name, role: account.role, workspaceId: account.workspaceId } };
  }
}
