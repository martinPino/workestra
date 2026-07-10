# Workestra — agent guide

SaaS platform for AI agent orchestration with a visual workflow editor (DAG).
Full architecture and execution flow: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
Read it before changes that cross layers.

## Structure

pnpm + Turbo monorepo. Clean / hexagonal architecture.

- `apps/api` — NestJS: REST + WS gateway, OIDC/JWT auth, RBAC, multitenancy, BullMQ enqueue.
- `apps/worker` — Durable BullMQ process that runs `@core/engine` (same engine as the API).
- `apps/web` — React + React Flow + Zustand + React Query (editor, console, marketplace).
- `packages/contracts` (`@core/contracts`) — Zod schemas, DTOs, events, plugin SPIs.
- `packages/domain` (`@core/domain`) — Pure DAG entities and rules. No IO.
- `packages/engine` (`@core/engine`) — `WorkflowRunner` over ports. No NestJS/Prisma.
- `packages/infra` (`@core/infra`) — Prisma/Redis/BullMQ adapters + `schema.prisma`.
- `packages/sdk-plugins` (`@core/sdk-plugins`) — Runtime for nodes, tools, connectors.
- `packages/llm` (`@core/llm`) — Provider router (anthropic, openai/groq, mock).

## Architecture rules (enforced by `pnpm depcruise`)

- `domain` and `engine` do NOT import frameworks, ORM or adapters. The engine receives its
  dependencies via **port injection** (`packages/engine/src/ports.ts`), not via decorators.
- `web` never imports the backend core.
- Adding a node type, tool or connector is done via **registry/plugin** (Open/Closed), without
  touching the `WorkflowRunner`.
- `@core/contracts` is versioned with **SemVer + changesets**; a breaking change without a bump
  fails CI.

## Gotchas (learned the hard way)

- **Rebuild `dist` after editing `@core/*`.** Packages are consumed from their compiled `dist`,
  not from source. After editing `contracts`/`engine`/etc., run
  `pnpm --filter @core/<pkg> build` before typecheck/test downstream. `pnpm verify` already
  handles the ordering.
- **`pnpm verify` does NOT boot the Nest DI container.** A guard whose module isn't registered
  passes `verify` but crash-loops on Railway. Watch the deploy after API changes.
- **Prod uses real auth.** `NODE_ENV=production` requires a custom `JWT_SECRET` or the API won't
  start.

## Commands

- `pnpm dev` — api (3001) + web (5173) + worker.
- `pnpm build` — incremental build (turbo).
- `pnpm verify` — build + typecheck + lint + depcruise + test. **Run before considering a change done.**
- `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:seed` — Prisma (needs `docker compose up -d`).

## Execution modes

- `DISPATCH=inline` (default) | `queue` (BullMQ + worker).
- `PERSISTENCE=memory` (default, no infra) | `postgres`.
