import { signJwt, verifyJwt, type JwtPayload } from '../http/jwt';

/**
 * Firma y verificación de los JWT de sesión, como PUERTO.
 *
 * Existe porque los dos runtimes lo hacen distinto: `@nestjs/jwt` envuelve `jsonwebtoken`, que usa el
 * `crypto` de Node de forma síncrona, y en Workers solo hay WebCrypto, que es asíncrono. Inyectarlo
 * permite que `AuthService` —con toda la lógica de registro, login, trabajo señuelo y cuenta cerrada—
 * sea EL MISMO en los dos sitios en vez de duplicarse.
 *
 * La interfaz es asíncrona porque es el mínimo común: envolver algo síncrono en una promesa es gratis,
 * al revés no se puede.
 */
export interface TokenSigner {
  sign(payload: JwtPayload, expiresInSeconds?: number): Promise<string>;
  verify(token: string): Promise<JwtPayload>;
  /**
   * Firma claims ARBITRARIOS con el mismo secreto. Lo usa el `oauth_state` de conectores, que no es un
   * principal: lleva `{ cid, ws, kind: 'oauth_state', jti }`. Por eso el middleware de auth rechaza
   * cualquier token con `kind` — comparten secreto, y sin esa comprobación un state valdría como sesión.
   */
  signClaims(claims: Record<string, unknown>, expiresInSeconds?: number): Promise<string>;
  verifyClaims(token: string): Promise<Record<string, unknown>>;
}

/**
 * Implementación sobre WebCrypto. Es la del Worker, y también la que usarán los tests: no depende de
 * Node ni de Nest. Produce y acepta exactamente los mismos tokens que `@nestjs/jwt` con el mismo
 * secreto (HS256), que es lo que permite que las sesiones sobrevivan al corte.
 */
export class WebCryptoTokenSigner implements TokenSigner {
  constructor(private readonly secret: string) {}
  sign(payload: JwtPayload, expiresInSeconds?: number): Promise<string> {
    return signJwt(payload, this.secret, expiresInSeconds);
  }
  verify(token: string): Promise<JwtPayload> {
    return verifyJwt(token, this.secret);
  }
  signClaims(claims: Record<string, unknown>, expiresInSeconds?: number): Promise<string> {
    return signJwt(claims as unknown as JwtPayload, this.secret, expiresInSeconds);
  }
  async verifyClaims(token: string): Promise<Record<string, unknown>> {
    return (await verifyJwt(token, this.secret)) as unknown as Record<string, unknown>;
  }
}

export type { JwtPayload };
