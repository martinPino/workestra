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

/**
 * Ejecuta `fn` en modo SISTEMA: sin tenant, de modo que RLS NO filtra y se ve todo (M84).
 *
 * Existe por una sola razón: el panel de analítica de plataforma tiene que cruzar todos los workspaces,
 * y durante una petición autenticada el contexto ya trae el tenant del JWT, así que RLS lo acotaría.
 *
 * Es deliberadamente FEO de invocar y fácil de encontrar con un grep. Quien lo llame debe haber
 * comprobado ANTES que quien pide es administrador de plataforma; esta función no comprueba nada, solo
 * quita la red. Todo uso nuevo debería mirarse con la misma lupa que un `DROP`.
 */
export function runInSystemMode<T>(fn: () => T): T {
  return storage.run({}, fn);
}
