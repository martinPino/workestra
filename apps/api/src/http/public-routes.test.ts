import { describe, it, expect } from 'vitest';
import { isPublicRoute, publicRoutes } from './public-routes';

describe('superficie pública (deny-by-default)', () => {
  it('deja pasar las rutas declaradas', () => {
    expect(isPublicRoute('GET', '/health')).toBe(true);
    expect(isPublicRoute('POST', '/auth/login')).toBe(true);
    expect(isPublicRoute('POST', '/auth/register')).toBe(true);
    expect(isPublicRoute('GET', '/connectors/callback')).toBe(true);
    expect(isPublicRoute('POST', '/hooks/abc123')).toBe(true);
    expect(isPublicRoute('GET', '/shares/tok_xyz')).toBe(true);
    expect(isPublicRoute('GET', '/ingest/config')).toBe(true);
    expect(isPublicRoute('POST', '/team/invite/tok/accept')).toBe(true);
  });

  it('NO abre las rutas con sesión que comparten prefijo con una pública', () => {
    // El caso que motiva que la lista sea de literales y no de prefijos: `/connectors/callback` es
    // público, pero `/connectors/:id/...` maneja credenciales OAuth del workspace.
    expect(isPublicRoute('GET', '/connectors/abc/drive-folders')).toBe(false);
    expect(isPublicRoute('GET', '/connectors')).toBe(false);
    expect(isPublicRoute('DELETE', '/connectors/abc')).toBe(false);
    // Leer un share es público; importarlo o revocarlo, no.
    expect(isPublicRoute('POST', '/shares/tok/import')).toBe(false);
    expect(isPublicRoute('DELETE', '/shares/tok')).toBe(false);
    // La ingesta exige sesión aunque su hermana /config no.
    expect(isPublicRoute('POST', '/ingest')).toBe(false);
    // Ver el equipo exige sesión aunque aceptar una invitación no.
    expect(isPublicRoute('GET', '/team/members')).toBe(false);
  });

  it('distingue el método: mismo path con otro verbo no hereda el permiso', () => {
    expect(isPublicRoute('GET', '/mcp/una-clave')).toBe(true);
    expect(isPublicRoute('PATCH', '/mcp/una-clave')).toBe(false);
    expect(isPublicRoute('GET', '/auth/login')).toBe(false);
  });

  it('un `:param` no cruza barras', () => {
    // Sin anclar el segmento, `/shares/:token` dejaría pasar `/shares/x/import`.
    expect(isPublicRoute('GET', '/shares/a/b')).toBe(false);
    expect(isPublicRoute('POST', '/hooks/a/b')).toBe(false);
  });

  it('deniega lo desconocido', () => {
    expect(isPublicRoute('GET', '/workflows')).toBe(false);
    expect(isPublicRoute('GET', '/agents')).toBe(false);
    expect(isPublicRoute('GET', '/insights/overview')).toBe(false);
    expect(isPublicRoute('GET', '/')).toBe(true); // salvo la raíz, que es health check
  });

  it('cada ruta pública documenta por qué lo es', () => {
    // Una ruta sin justificación es una que nadie revisó: el campo es obligatorio a propósito.
    for (const r of publicRoutes()) expect(r.why.length).toBeGreaterThan(10);
  });
});
