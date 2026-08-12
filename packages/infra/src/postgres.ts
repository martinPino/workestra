/**
 * Entry point `@core/infra/postgres`: los adaptadores PORTABLES, los que funcionan igual en Node y en
 * Cloudflare Workers porque solo hablan con el `PrismaClient` que se les inyecta.
 *
 * Es el barrel principal MENOS dos ficheros:
 *  - `prisma.ts`, la factoría del cliente con motor nativo (en Workers se usa `createHyperdrivePrismaClient`).
 *  - `adapters/email.ts`, único sitio del paquete con un import de Node en tiempo de ejecución
 *    (`nodemailer`, que abre un socket SMTP). Su alternativa HTTP se exporta abajo.
 *
 * Nota sobre `ioredis`: NO hace falta excluirlo. Los adaptadores de Redis lo importan solo como TIPO
 * (`import type`), así que se borra al compilar y nunca llega al bundle. Se exportan aquí porque son
 * inertes; lo que el Worker usa de verdad son los equivalentes de `@core/infra/cloudflare`.
 */
export * from './workspace-context';
export * from './adapters/memory';
export * from './adapters/memory-workflow';
export * from './adapters/memory-store';
export * from './adapters/agent-repo';
export * from './adapters/pending-review';
export * from './adapters/prisma-pending-review';
export * from './adapters/prisma-execution-repository';
export * from './adapters/prisma-workflow';
export * from './adapters/redis';
export * from './adapters/event-publishers';
export * from './adapters/event-store';
export * from './adapters/secret-store';
export * from './adapters/webhook-repo';
export * from './adapters/schedule-repo';
export * from './adapters/connector-repo';
export * from './adapters/trigger-binding-repo';
export * from './adapters/api-key-repo';
export * from './adapters/workspace-usage-repo';
export * from './adapters/mcp-http-client';
export * from './adapters/mcp-tool-resolver';
export * from './adapters/file-store';
export * from './adapters/auth-repo';
export * from './adapters/identity-store';
export * from './adapters/team-repo';
export * from './adapters/email-http';
export * from './password';
export * from './analytics/postgres-sink';
export * from './analytics/noop-sink';
export * from './adapters/share-repo';
