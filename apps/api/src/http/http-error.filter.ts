import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { HttpError } from './common';

/**
 * Traduce los `HttpError` de `http/common.ts` a respuestas HTTP dentro de NestJS.
 *
 * Existe por una razón concreta y temporal: los servicios ya no lanzan las excepciones de
 * `@nestjs/common`, y Nest solo sabe mapear las suyas. Sin este filtro, un `NotFoundException` de los
 * nuestros caería en el manejador por defecto y saldría como **500 en vez de 404** — un cambio de
 * contrato silencioso en el API que todavía sirve Railway, del tipo que no rompe ningún test y se
 * descubre en producción.
 *
 * Se puede borrar cuando se apague el servicio `api` de Railway (paso 5 del orden de corte).
 */
@Catch(HttpError)
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: HttpError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): void } }>();
    // Se sirve `payload`, no un objeto reconstruido: es lo que conserva el cuerpo VERBATIM cuando la
    // excepción se lanzó con un objeto (errores del DAG, issues de Zod), igual que hacía Nest.
    res.status(exception.status).json(exception.payload);
  }
}
