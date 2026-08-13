import { Inject, Injectable } from '../http/common';
import type { Role } from '@core/contracts';
import type { RegisterDto, LoginDto } from '@core/contracts';
import { hashPassword, verifyPassword } from '@core/infra/postgres';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/bundle';

import type { TokenSigner } from './token-signer';
import type { JwtPayload } from '../http/jwt';
export type { JwtPayload };

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
const SESSION_TTL_SECONDS = 7 * 24 * 3600;
const DEV_TTL_SECONDS = 3600;

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: TokenSigner,
    @Inject(PERSISTENCE) private readonly persistence: PersistenceBundle,
  ) {}

  /** DEV ONLY: emite un token de pruebas para cualquier workspace/rol. Gateado en el controller. */
  issueDevToken(p: JwtPayload): Promise<string> {
    return this.jwt.sign(p, DEV_TTL_SECONDS);
  }

  verify(token: string): Promise<JwtPayload> {
    return this.jwt.verify(token);
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
  async issueSession(account: { id: string; email: string; name: string; role: Role; workspaceId: string }): Promise<SessionResult> {
    const payload: JwtPayload = { sub: account.id, email: account.email, role: account.role, workspaceId: account.workspaceId };
    const accessToken = await this.jwt.sign(payload, SESSION_TTL_SECONDS);
    return { accessToken, user: { id: account.id, email: account.email, name: account.name, role: account.role, workspaceId: account.workspaceId } };
  }
}
