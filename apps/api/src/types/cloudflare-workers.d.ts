/**
 * Declaración mínima del módulo VIRTUAL `cloudflare:workers`, que solo existe dentro del runtime y por
 * tanto no tiene tipos que TypeScript pueda resolver por sí mismo.
 *
 * Se declara a mano en vez de instalar `@cloudflare/workers-types` por la misma razón que en
 * `@core/infra/cloudflare`: ese paquete declara globals (`Request`, `Response`, `fetch`…) que CHOCAN con
 * los de `@types/node`, y este paquete compila con los de Node. Aquí solo hace falta la superficie que
 * se usa de verdad.
 */
declare module 'cloudflare:workers' {
  /** Un paso durable dentro de un Workflow: su resultado se persiste y no se vuelve a ejecutar. */
  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: string | number): Promise<void>;
    waitForEvent<T = unknown>(name: string, options: { type: string; timeout?: string | number }): Promise<T>;
  }

  /** Lo que el runtime entrega al arrancar una instancia. */
  export interface WorkflowEvent<T> {
    payload: T;
    timestamp: Date;
    instanceId: string;
  }

  /**
   * Clase base de un Workflow. Extenderla NO es opcional: el despliegue valida que la clase exportada
   * sea un WorkflowEntrypoint y falla con `code 10021` si es una clase plana, por muy exportada que esté.
   */
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected ctx: { waitUntil(promise: Promise<unknown>): void };
    protected env: Env;
    constructor(ctx: unknown, env: Env);
    abstract run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<unknown>;
  }
}
