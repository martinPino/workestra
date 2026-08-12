/**
 * Entry point `@core/infra/cloudflare`: adaptadores que implementan los puertos de `@core/engine` sobre
 * primitivas de Cloudflare (R2, Durable Objects, Hyperdrive).
 *
 * Está SEPARADO del barrel principal a propósito. `@core/infra` reexporta los adaptadores de Prisma,
 * Redis y nodemailer; importarlo desde un Worker metería `ioredis` y `nodemailer` en el bundle, que
 * tiene un techo de 10 MB y no puede abrir sockets TCP crudos de todas formas. Desde el Worker se
 * importa SOLO de aquí, y de `@core/infra` únicamente los adaptadores de Prisma (que sí son portables,
 * porque hablan por el cliente que se les inyecta).
 */
export * from './bindings';
export * from './protocol';
export * from './execution-room';
export * from './r2-file-store';
export * from './workspace-usage';
export * from './prisma';
export { createHttpEmailService, ConsoleEmailAdapter, ResendEmailAdapter, BrevoEmailAdapter } from '../adapters/email-http';
