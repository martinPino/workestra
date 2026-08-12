/**
 * Errores HTTP del API, sin NestJS.
 *
 * Conservan los NOMBRES de las excepciones de `@nestjs/common` a propósito: los 23 servicios las lanzan
 * en decenas de sitios, y mantener el nombre convierte la migración en un cambio de línea de import por
 * fichero en vez de una reescritura de la lógica de errores. Lo que cambia es quién las traduce a una
 * respuesta: antes el filtro de excepciones de Nest, ahora `onError` del app de Hono.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestException extends HttpError {
  constructor(message = 'Bad Request') {
    super(400, message);
  }
}

export class UnauthorizedException extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, message);
  }
}

export class ForbiddenException extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}

export class NotFoundException extends HttpError {
  constructor(message = 'Not Found') {
    super(404, message);
  }
}

export class ConflictException extends HttpError {
  constructor(message = 'Conflict') {
    super(409, message);
  }
}

export class UnprocessableEntityException extends HttpError {
  constructor(message = 'Unprocessable Entity') {
    super(422, message);
  }
}

export class InternalServerErrorException extends HttpError {
  constructor(message = 'Internal Server Error') {
    super(500, message);
  }
}

/**
 * Decoradores no-op que reemplazan a los de Nest. En Workers no hay contenedor DI: los servicios se
 * construyen a mano en `composition.ts`. Se conservan como no-op —en vez de borrarlos— porque quitarlos
 * obligaría a tocar los constructores de los 23 servicios, y este cambio debe ser mecánico: cuanto menos
 * se toque la lógica de negocio en una migración de plataforma, menos sitios donde mirar si algo falla.
 */
export const Injectable = (): ClassDecorator => () => {};
export const Inject = (): ParameterDecorator => () => {};

/**
 * Traduce cualquier error a `{ status, body }`. Un error que NO sea `HttpError` es un fallo no previsto:
 * se registra completo pero se responde 500 genérico, para no filtrar internals (rutas, SQL, credenciales
 * en un mensaje de driver) a un cliente no autenticado.
 */
export function toErrorResponse(err: unknown): { status: number; body: { statusCode: number; message: string } } {
  if (err instanceof HttpError) {
    return { status: err.status, body: { statusCode: err.status, message: err.message } };
  }
  console.error('[api] error no controlado:', err instanceof Error ? err.stack : String(err));
  return { status: 500, body: { statusCode: 500, message: 'Internal Server Error' } };
}
