import { NotFoundException } from '../http/common';

/**
 * Verifica que un recurso pertenece al workspace AUTENTICADO. Lanza 404 (no 403) a propósito: no
 * revelamos la existencia de recursos de otros tenants (evita enumeración cross-tenant).
 */
export function assertInWorkspace(resourceWorkspaceId: string | null | undefined, workspaceId: string, label = 'Recurso'): void {
  if (resourceWorkspaceId !== workspaceId) {
    throw new NotFoundException(`${label} no encontrado.`);
  }
}
