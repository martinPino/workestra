import { describe, it, expect } from 'vitest';
import { networkOf } from './rate-limit.middleware';

describe('agrupamiento por subred del rate-limit', () => {
  it('agrupa un pool de IPv4 en su /24', () => {
    // El caso que motivó el cambio: 13 intentos seguidos salieron por 13 IPs distintas de este mismo
    // rango y el límite por IP exacta no saltó ni una vez.
    const pool = ['160.79.106.128', '160.79.106.133', '160.79.106.137', '160.79.106.139'];
    const nets = new Set(pool.map(networkOf));
    expect(nets.size).toBe(1);
    expect([...nets][0]).toBe('160.79.106.0/24');
  });

  it('NO agrupa subredes distintas', () => {
    expect(networkOf('160.79.106.1')).not.toBe(networkOf('160.79.107.1'));
    expect(networkOf('10.0.0.1')).not.toBe(networkOf('10.0.1.1'));
  });

  it('agrupa IPv6 por /64', () => {
    const a = networkOf('2a05:d014:7c9:4e00:a35:61:a24f:aa0e');
    const b = networkOf('2a05:d014:7c9:4e00:ffff:1:2:3');
    expect(a).toBe(b);
    expect(a).toBe('2a05:d014:7c9:4e00::/64');
    // Distinto /64 ⇒ distinta clave.
    expect(networkOf('2a05:d014:7c9:4e01::1')).not.toBe(a);
  });

  it('deja pasar tal cual lo que no es una IP reconocible', () => {
    // `unknown` es el valor que se usa cuando falta CF-Connecting-IP: no debe romper ni colapsar
    // todas las peticiones desconocidas en una clave sorpresa.
    expect(networkOf('unknown')).toBe('unknown');
  });
});
