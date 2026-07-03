import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marca una ruta como PÚBLICA (sin JWT): la usa el guard global para saltar la autenticación. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
