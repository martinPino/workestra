import { describe, it, expect } from 'vitest';
import { EnvelopeCrypto, InMemorySecretStore } from './secret-store';

describe('EnvelopeCrypto (AES-256-GCM, M7)', () => {
  it('round-trip: descifrar lo cifrado devuelve el texto claro', () => {
    const c = new EnvelopeCrypto('0123456789abcdef0123456789abcdef'); // 32 chars
    const enc = c.encrypt('hunter2-signing-secret');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('hunter2');
    expect(c.decrypt(enc)).toBe('hunter2-signing-secret');
  });

  it('el ciphertext es NO determinista (IV aleatorio) pero descifra igual', () => {
    const c = new EnvelopeCrypto('clave-maestra-de-prueba');
    const a = c.encrypt('mismo');
    const b = c.encrypt('mismo');
    expect(a).not.toBe(b); // IV distinto
    expect(c.decrypt(a)).toBe('mismo');
    expect(c.decrypt(b)).toBe('mismo');
  });

  it('GCM detecta manipulación del ciphertext', () => {
    const c = new EnvelopeCrypto('otra-clave');
    const enc = c.encrypt('valor');
    const tampered = enc.slice(0, -4) + 'AAAA';
    expect(() => c.decrypt(tampered)).toThrow();
  });

  it('parsea claves HEX de 64 chars sin ambigüedad (no las trata como base64)', () => {
    const hexKey = 'ff'.repeat(32); // 64 hex chars = 32 bytes exactos
    const enc = new EnvelopeCrypto(hexKey).encrypt('dato');
    // Otra instancia con la MISMA clave hex debe descifrar (derivación determinista, no SHA256).
    expect(new EnvelopeCrypto(hexKey).decrypt(enc)).toBe('dato');
  });

  it('acepta base64 canónico de 32 bytes como clave', () => {
    const b64Key = Buffer.alloc(32, 7).toString('base64');
    const c = new EnvelopeCrypto(b64Key);
    expect(c.decrypt(c.encrypt('x'))).toBe('x');
  });
});

describe('InMemorySecretStore (M7)', () => {
  it('set/get por workspace, aislado entre tenants, y list solo devuelve claves', async () => {
    const store = new InMemorySecretStore(new EnvelopeCrypto('k-de-test-1234567890'));
    await store.set('ws1', 'api-key', 'sk-123');
    await store.set('ws1', 'webhook:h1:signing', 'whsec_abc');
    await store.set('ws2', 'api-key', 'otro');

    expect(await store.get('ws1', 'api-key')).toBe('sk-123');
    expect(await store.get('ws2', 'api-key')).toBe('otro'); // aislado por tenant
    expect(await store.get('ws1', 'inexistente')).toBeNull();
    expect(await store.list('ws1')).toEqual(['api-key', 'webhook:h1:signing']); // claves, no valores

    await store.delete('ws1', 'api-key');
    expect(await store.get('ws1', 'api-key')).toBeNull();
  });
});
