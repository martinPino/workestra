/**
 * Reemplazo de `@nestjs/common` para los servicios: errores HTTP, decoradores no-op y `Logger`.
 *
 * Los servicios importan de aquí en lugar de `@nestjs/common`, y siguen funcionando en LOS DOS
 * runtimes: el Worker traduce estos errores con `toErrorResponse` y la app de Nest con el filtro de
 * `http-error.filter.ts`. Sin ese filtro, Nest no reconocería estas excepciones y devolvería 500 donde
 * antes daba 400/403 — un cambio de contrato silencioso en el API que todavía sirve Railway.
 *
 * Conservan los NOMBRES de las excepciones de `@nestjs/common` a propósito: los 23 servicios las lanzan
 * en decenas de sitios, y mantener el nombre convierte la migración en un cambio de línea de import por
 * fichero en vez de una reescritura de la lógica de errores. Lo que cambia es quién las traduce a una
 * respuesta: antes el filtro de excepciones de Nest, ahora `onError` del app de Hono.
 */
/**
 * Cuerpo de la respuesta. Se admite un OBJETO además de un string porque varios endpoints ya lo usan
 * para devolver el detalle de una validación —los errores del DAG, los issues de Zod, el informe de un
 * share— y ese detalle es lo que el editor pinta. Se replica la semántica de Nest al pie de la letra:
 * un objeto sale VERBATIM como cuerpo; un string se envuelve en `{ statusCode, message, error }`.
 * Cualquier desviación aquí cambiaría en silencio lo que recibe la web.
 */
export type ErrorResponse = string | Record<string, unknown>;

export class HttpError extends Error {
  /** El cuerpo tal cual se serializa. */
  readonly payload: Record<string, unknown>;

  constructor(
    readonly status: number,
    response: ErrorResponse,
  ) {
    const message = typeof response === 'string' ? response : String(response.message ?? 'Error');
    super(message);
    this.name = new.target.name;
    this.payload =
      typeof response === 'string' ? { statusCode: status, message, error: new.target.name } : { ...response };
  }
}

export class BadRequestException extends HttpError {
  constructor(response: ErrorResponse = 'Bad Request') {
    super(400, response);
  }
}

export class UnauthorizedException extends HttpError {
  constructor(response: ErrorResponse = 'Unauthorized') {
    super(401, response);
  }
}

export class ForbiddenException extends HttpError {
  constructor(response: ErrorResponse = 'Forbidden') {
    super(403, response);
  }
}

export class NotFoundException extends HttpError {
  constructor(response: ErrorResponse = 'Not Found') {
    super(404, response);
  }
}

export class ConflictException extends HttpError {
  constructor(response: ErrorResponse = 'Conflict') {
    super(409, response);
  }
}

export class UnprocessableEntityException extends HttpError {
  constructor(response: ErrorResponse = 'Unprocessable Entity') {
    super(422, response);
  }
}

export class InternalServerErrorException extends HttpError {
  constructor(response: ErrorResponse = 'Internal Server Error') {
    super(500, response);
  }
}

/**
 * Decoradores no-op que reemplazan a los de Nest. En Workers no hay contenedor DI: los servicios se
 * construyen a mano en `composition.ts`. Se conservan como no-op —en vez de borrarlos— porque quitarlos
 * obligaría a tocar los constructores de los 23 servicios, y este cambio debe ser mecánico: cuanto menos
 * se toque la lógica de negocio en una migración de plataforma, menos sitios donde mirar si algo falla.
 */
export const Injectable = (): ClassDecorator => () => {};
export const Inject = (_token?: unknown): ParameterDecorator => () => {};

/**
 * Hooks de ciclo de vida, como interfaces vacías. Nest detecta estos hooks comprobando si el MÉTODO
 * existe en la instancia, no por la interfaz que declare la clase, así que declararlos desde aquí no
 * cambia nada en Railway. En el Worker no hay ciclo de vida de módulo: quien los necesite se los llama.
 */
export interface OnModuleInit {
  onModuleInit(): void | Promise<void>;
}
export interface OnModuleDestroy {
  onModuleDestroy(): void | Promise<void>;
}

/**
 * Logger con la firma del de Nest, sobre `console`. En Workers no hay transportes ni niveles
 * configurables: lo que se escribe va al stream de observabilidad del Worker.
 */
export class Logger {
  constructor(private readonly context?: string) {}
  private prefix(): string {
    return this.context ? `[${this.context}]` : '[api]';
  }
  log(message: unknown, ...rest: unknown[]): void {
    console.log(this.prefix(), message, ...rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    console.warn(this.prefix(), message, ...rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    console.error(this.prefix(), message, ...rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    console.debug(this.prefix(), message, ...rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    console.debug(this.prefix(), message, ...rest);
  }
}

/**
 * Traduce cualquier error a `{ status, body }`. Un error que NO sea `HttpError` es un fallo no previsto:
 * se registra completo pero se responde 500 genérico, para no filtrar internals (rutas, SQL, credenciales
 * en un mensaje de driver) a un cliente no autenticado.
 */
export function toErrorResponse(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof HttpError) {
    return { status: err.status, body: err.payload };
  }
  console.error('[api] error no controlado:', err instanceof Error ? err.stack : String(err));
  return { status: 500, body: { statusCode: 500, message: 'Internal Server Error' } };
}
