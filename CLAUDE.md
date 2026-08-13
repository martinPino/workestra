# Workestra — agent guide

SaaS platform for AI agent orchestration with a visual workflow editor (DAG).
Full architecture and execution flow: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
Read it before changes that cross layers.

## Structure

pnpm + Turbo monorepo. Clean / hexagonal architecture.

- `apps/api` — Cloudflare Worker (Hono): REST, JWT auth, RBAC, multitenancy, WebSocket over Durable
  Objects, and the `ExecutionWorkflow` + cron trigger that run `@core/engine`.
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
- **`pnpm verify` does NOT bundle for `workerd`.** An import that drags a Node-only module into the
  Worker passes `verify` green and only fails at deploy. That is what CI's
  `wrangler deploy --dry-run` step is for — run it locally after touching imports in `apps/api` or
  `@core/infra`.
- **Import `@core/infra/postgres`, not `@core/infra`, from `apps/api`.** The main barrel re-exports
  `nodemailer`, the one runtime Node dependency left in the package.
- **Prod uses real auth.** The Worker refuses to serve without a custom `JWT_SECRET`.

## Commands

- `pnpm dev` — api (`wrangler dev`) + web (5173).
- `pnpm build` — incremental build (turbo).
- `pnpm verify` — build + typecheck + lint + depcruise + test. **Run before considering a change done.**
- `pnpm deploy` — publica el Worker del API y la web a Cloudflare.
- `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:seed` — Prisma (needs `docker compose up -d`).

## Execution modes

- Despacho: **Cloudflare Workflows** cuando hay binding `EXECUTION`; inline en su ausencia
  (`wrangler dev`), con el techo de 5 min de CPU.
- `PERSISTENCE=memory` (default, no infra) | `postgres`. En Cloudflare siempre es postgres.
