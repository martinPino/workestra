import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, isScryptHash } from './password';
import { InMemoryAuthRepository } from './adapters/auth-repo';

describe('password (scrypt)', () => {
  it('hashea y verifica la misma contraseña', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(isScryptHash(hash)).toBe(true);
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
  });

  it('rechaza una contraseña incorrecta', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(await verifyPassword('otra', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('el salt es aleatorio: el mismo texto da hashes distintos', async () => {
    const a = await hashPassword('misma');
    const b = await hashPassword('misma');
    expect(a).not.toBe(b);
    expect(await verifyPassword('misma', a)).toBe(true);
    expect(await verifyPassword('misma', b)).toBe(true);
  });

  it('un hash con formato desconocido o corrupto devuelve false, no lanza', async () => {
    expect(await verifyPassword('x', 'sha256deadbeef')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$16384$8$1$$')).toBe(false);
    expect(isScryptHash('bcrypt$...')).toBe(false);
  });
});

describe('InMemoryAuthRepository', () => {
  it('alta crea cuenta con workspace propio y rol OWNER; email en minúsculas', async () => {
    const repo = new InMemoryAuthRepository();
    const acc = await repo.createAccount({ email: 'Nuevo@Empresa.COM', passwordHash: 'h', name: 'Nuevo' });
    expect(acc.email).toBe('nuevo@empresa.com');
    expect(acc.role).toBe('OWNER');
    expect(acc.workspaceId).toBeTruthy();
    // findByEmail es insensible a mayúsculas
    expect((await repo.findByEmail('NUEVO@empresa.com'))?.id).toBe(acc.id);
  });

  it('rechaza email duplicado', async () => {
    const repo = new InMemoryAuthRepository();
    await repo.createAccount({ email: 'dup@x.com', passwordHash: 'h', name: 'A' });
    await expect(repo.createAccount({ email: 'dup@x.com', passwordHash: 'h', name: 'B' })).rejects.toThrow(/EMAIL_TAKEN/);
  });

  it('la semilla queda consultable por email', async () => {
    const repo = new InMemoryAuthRepository([{ email: 'owner@acme.dev', name: 'Owner', passwordHash: 'h', workspaceId: 'ws_dev', role: 'OWNER' }]);
    const acc = await repo.findByEmail('owner@acme.dev');
    expect(acc?.workspaceId).toBe('ws_dev');
    expect(acc?.role).toBe('OWNER');
    expect(await repo.findByEmail('noexiste@x.com')).toBeNull();
  });
});
