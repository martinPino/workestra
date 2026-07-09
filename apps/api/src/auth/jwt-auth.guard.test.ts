import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AuthAccount } from '@core/engine';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from './auth.service';
import type { PersistenceBundle } from '../persistence/persistence.module';

// El Reflector llama a Reflect.getMetadata sobre getHandler()/getClass(); deben ser objetos REALES (no
// undefined) o lanza. Un handler/clase vacíos no tienen la metadata @Public → la ruta se trata como privada.
const handler = function handler() {};
class DummyController {}
function reqCtx(headers: Record<string, string>): ExecutionContext {
  const request = { headers }; // referencia ESTABLE: el guard escribe req.user aquí y el test lo lee
  return {
    getHandler: () => handler,
    getClass: () => DummyController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
const ctxWith = (token: string): ExecutionContext => reqCtx({ authorization: `Bearer ${token}` });

/** Guard + AuthService con un findByEmail controlable (o que lanza, para simular caída de BD). */
function makeGuard(findByEmail: (email: string) => Promise<AuthAccount | null>) {
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } });
  const persistence = { auth: { findByEmail }, apiKeys: {} } as unknown as PersistenceBundle;
  const guard = new JwtAuthGuard(new AuthService(jwt, persistence), new Reflector(), persistence);
  return { guard, auth: new AuthService(jwt, persistence) };
}

const account = (email: string, over: Partial<AuthAccount> = {}): AuthAccount => ({
  id: 'u_' + email,
  email,
  name: 'X',
  passwordHash: 'h',
  role: 'EDITOR',
  workspaceId: 'ws1',
  organizationId: 'org1',
  disabledAt: null,
  ...over,
});

describe('JwtAuthGuard — revocación por cuenta cerrada (M74)', () => {
  it('acepta una sesión de una cuenta activa y usa rol/workspace de la BD', async () => {
    const { guard, auth } = makeGuard(async (e) => account(e, { role: 'ADMIN', workspaceId: 'wsX' }));
    const { accessToken } = auth.issueSession({ id: 'u1', email: 'a@t.com', name: 'A', role: 'EDITOR', workspaceId: 'ws-token' });
    const ctx = ctxWith(accessToken);
    expect(await guard.canActivate(ctx)).toBe(true);
    const req = ctx.switchToHttp().getRequest() as { user: { role: string; workspaceId: string } };
    // el rol/workspace vienen de la BD (ADMIN/wsX), no del token (EDITOR/ws-token)
    expect(req.user.role).toBe('ADMIN');
    expect(req.user.workspaceId).toBe('wsX');
  });

  it('RECHAZA una sesión válida cuya cuenta fue cerrada (disabledAt)', async () => {
    const { guard, auth } = makeGuard(async (e) => account(e, { disabledAt: new Date() }));
    const { accessToken } = auth.issueSession({ id: 'u2', email: 'closed@t.com', name: 'C', role: 'EDITOR', workspaceId: 'ws1' });
    await expect(guard.canActivate(ctxWith(accessToken))).rejects.toThrow(/desactivada/i);
  });

  it('fail-open: si la BD falla, acepta con los datos del token (no tumba la auth)', async () => {
    const { guard, auth } = makeGuard(async () => {
      throw new Error('db down');
    });
    const { accessToken } = auth.issueSession({ id: 'u3', email: 'dberr@t.com', name: 'D', role: 'EDITOR', workspaceId: 'wsE' });
    expect(await guard.canActivate(ctxWith(accessToken))).toBe(true);
  });

  it('rechaza si falta el Bearer', async () => {
    const { guard } = makeGuard(async () => null);
    await expect(guard.canActivate(reqCtx({}))).rejects.toThrow(/Bearer/);
  });
});
