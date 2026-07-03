import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto de tenant por petición (M10). La extensión RLS del cliente Prisma (ver `prisma.ts`) lee
 * de aquí el `workspaceId` para fijar `app.current_workspace` en cada transacción, activando las
 * políticas de `prisma/rls.sql`. El store es MUTABLE: un middleware abre el contexto al inicio de la
 * petición y el guard de auth escribe el workspace tras validar el JWT (cuando ya se conoce).
 */
export interface WorkspaceStore {
  workspaceId?: string;
}

const storage = new AsyncLocalStorage<WorkspaceStore>();

/** Ejecuta `fn` dentro de un contexto de tenant. El `store` se pasa por referencia (mutable). */
export function runInWorkspaceContext<T>(store: WorkspaceStore, fn: () => T): T {
  return storage.run(store, fn);
}

/** Fija el workspace en el contexto activo (no-op si no hay contexto abierto). */
export function setCurrentWorkspace(workspaceId: string): void {
  const store = storage.getStore();
  if (store) store.workspaceId = workspaceId;
}

/** Workspace del contexto activo. `undefined` ⇒ modo SISTEMA: RLS no filtra (política permite NULL). */
export function currentWorkspace(): string | undefined {
  return storage.getStore()?.workspaceId;
}
