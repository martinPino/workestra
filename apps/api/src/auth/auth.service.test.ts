import { describe, it, expect } from 'vitest';
import { InMemoryAuthRepository } from '@core/infra/postgres';
import { WebCryptoTokenSigner } from './token-signer';
import { AuthService, EmailTakenError } from './auth.service';
import type { PersistenceBundle } from '../persistence/bundle';

/** Construye un AuthService con un firmante real y un bundle mínimo (solo `auth` importa aquí). */
function makeService(seedEmails: string[] = []) {
  const auth = new InMemoryAuthRepository(seedEmails.map((email) => ({ email, name: 'X', passwordHash: 'x', role: 'OWNER' as const })));
  const jwt = new WebCryptoTokenSigner('test-secret');
  const svc = new AuthService(jwt, { auth } as unknown as PersistenceBundle);
  return { svc, jwt };
}

function decode(jwt: WebCryptoTokenSigner, token: string) {
  return jwt.verify(token);
}

describe('AuthService — registro/login (M73)', () => {
  it('registro crea sesión con sub=user.id, rol OWNER y workspace propio', async () => {
    const { svc, jwt } = makeService();
    const s = await svc.register({ email: 'ana@empresa.com', password: 'supersecreta', name: 'Ana' });
    expect(s.user.email).toBe('ana@empresa.com');
    expect(s.user.role).toBe('OWNER');
    expect(s.user.workspaceId).toBeTruthy();
    const payload = await decode(jwt, s.accessToken);
    expect(payload.sub).toBe(s.user.id); // el JWT lleva el id REAL, no un sub arbitrario
    expect(payload.workspaceId).toBe(s.user.workspaceId);
    expect(payload.role).toBe('OWNER');
  });

  it('registro duplicado lanza EmailTakenError', async () => {
    const { svc } = makeService();
    await svc.register({ email: 'dup@x.com', password: 'contraseña1', name: 'A' });
    await expect(svc.register({ email: 'DUP@x.com', password: 'contraseña2', name: 'B' })).rejects.toBeInstanceOf(EmailTakenError);
  });

  it('login correcto tras registro; contraseña o email erróneos devuelven null', async () => {
    const { svc } = makeService();
    await svc.register({ email: 'leo@x.com', password: 'micontraseña', name: 'Leo' });
    expect(await svc.login({ email: 'leo@x.com', password: 'micontraseña' })).not.toBeNull();
    expect(await svc.login({ email: 'leo@x.com', password: 'incorrecta' })).toBeNull();
    expect(await svc.login({ email: 'noexiste@x.com', password: 'lo-que-sea' })).toBeNull();
  });

  it('el email es insensible a mayúsculas en login', async () => {
    const { svc } = makeService();
    await svc.register({ email: 'case@x.com', password: 'passcaseX', name: 'C' });
    expect(await svc.login({ email: 'CASE@X.com', password: 'passcaseX' })).not.toBeNull();
  });
});
