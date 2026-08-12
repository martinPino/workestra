import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwt } from './jwt';

const SECRET = 'un-secreto-de-pruebas';
const payload = { sub: 'u_1', email: 'a@b.dev', role: 'OWNER' as const, workspaceId: 'ws_1' };

describe('JWT HS256 sobre WebCrypto (sustituye a @nestjs/jwt)', () => {
  it('hace ida y vuelta del payload', async () => {
    const token = await signJwt(payload, SECRET);
    const back = await verifyJwt(token, SECRET);
    expect(back.sub).toBe('u_1');
    expect(back.email).toBe('a@b.dev');
    expect(back.role).toBe('OWNER');
    expect(back.workspaceId).toBe('ws_1');
  });

  it('rechaza un token firmado con OTRO secreto', async () => {
    const token = await signJwt(payload, 'otro-secreto');
    await expect(verifyJwt(token, SECRET)).rejects.toThrow(/inválido o expirado/);
  });

  it('rechaza un token con los claims manipulados', async () => {
    // Escalada de privilegios clásica: reescribir el rol conservando la firma original.
    const token = await signJwt({ ...payload, role: 'VIEWER' }, SECRET);
    const [head, , sig] = token.split('.');
    const forged = btoa(JSON.stringify({ ...payload, role: 'OWNER' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(verifyJwt(`${head}.${forged}.${sig}`, SECRET)).rejects.toThrow(/inválido o expirado/);
  });

  it('rechaza un token caducado', async () => {
    const token = await signJwt(payload, SECRET, -1);
    await expect(verifyJwt(token, SECRET)).rejects.toThrow(/inválido o expirado/);
  });

  it('rechaza un token sin firma o mal formado', async () => {
    await expect(verifyJwt('no-es-un-jwt', SECRET)).rejects.toThrow(/inválido o expirado/);
    await expect(verifyJwt('a.b', SECRET)).rejects.toThrow(/inválido o expirado/);
  });

  it('conserva `kind`, para que el middleware pueda rechazar tokens que no son de sesión', async () => {
    // El `oauth_state` de conectores se firma con el MISMO secreto: sin esta marca, valdría como sesión.
    const token = await signJwt({ ...payload, kind: 'oauth_state' }, SECRET);
    expect((await verifyJwt(token, SECRET)).kind).toBe('oauth_state');
  });
});
