import { SetMetadata } from '@nestjs/common';

export const SCOPES_KEY = 'required_scopes';

/** Declara los scopes requeridos por un handler/controlador. Ej.: @RequireScopes('workflow:write'). */
export const RequireScopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);
