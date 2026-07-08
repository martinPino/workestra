import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** scrypt como promesa, incluyendo el overload con opciones (N/r/p/maxmem) que `promisify` no tipa bien. */
function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)));
  });
}

/**
 * Hashing de contraseñas con scrypt (M73) — KDF integrada en Node, aceptada por OWASP. Se elige scrypt
 * (no argon2/bcrypt) para NO añadir una dependencia nativa que tenga que compilarse en el Docker de
 * Railway: cero riesgo de deploy. El formato guardado es autodescriptivo: `scrypt$N$r$p$saltB64$hashB64`,
 * así se puede subir el coste en el futuro sin romper los hashes existentes (la verificación lee sus params).
 */
const N = 16_384; // coste CPU/memoria (2^14)
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
// scrypt exige maxmem >= 128*N*r; con N=16384,r=8 son ~16MB. Damos margen (64MB) para no fallar.
const MAXMEM = 64 * 1024 * 1024;

/** Deriva la clave scrypt con los parámetros dados y la devuelve como Buffer. */
async function derive(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return (await scryptAsync(password, salt, keylen, { N: n, r, p, maxmem: MAXMEM })) as Buffer;
}

/** Hashea una contraseña. Devuelve una cadena autodescriptiva apta para guardar en `User.passwordHash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Verifica una contraseña contra un hash guardado. Constante en tiempo (timingSafeEqual). Devuelve false
 * ante cualquier formato desconocido o error (nunca lanza), para tratar un hash legado/corrupto como fallo
 * de credenciales y no como caída del login.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || salt.length === 0 || expected.length === 0) return false;
    const actual = await derive(password, salt, n, r, p, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** ¿La cadena tiene el formato de un hash scrypt de este módulo? (para migrar hashes legados). */
export function isScryptHash(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith('scrypt$') && stored.split('$').length === 6;
}
