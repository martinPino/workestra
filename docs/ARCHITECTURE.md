# Workestra Architecture

Workestra (formerly AgentFlow) is a SaaS platform for **AI agent orchestration with a visual
workflow editor**. Users draw a workflow as a directed acyclic graph (DAG) of nodes; an engine
executes it, dispatching in parallel with retries and timeouts. A lead agent (Orchestrator) can
coordinate sub-agents, invoke external tools and connectors, or pause for human intervention.
Everything that happens is recorded as an append-only event log that the web console replays live.

## The lifecycle of an execution

```
Web (editor + console)            React Flow · Zustand · React Query
        │  publishes workflow / subscribes over WebSocket
        ▼
API · NestJS                      REST · WS gateway · OIDC/JWT auth · RBAC · multitenancy
        │  dispatch
        ├─ inline  ──────────────┐   (engine runs inside the API; dev/demo)
        └─ queue → durable Worker ┤   (BullMQ; separate worker, resume-safe)
                                  ▼
Engine · WorkflowRunner           DAG scheduler · retries · timeouts · fan-out/fan-in
        │  runs nodes (plugins)
        ▼
Nodes: agent · orchestrator · tools/MCP · connector · human · router · code · extract · download
        │  persists + emits events
        ▼
Postgres (event log · versions · NodeRun)   +   Redis (context/checkpoint · pub/sub)
        │
        └─ events ──▶ Redis pub/sub ──▶ WS gateway ──▶ Web (nodes light up live)
```

1. **Web** — The editor (React Flow) builds the graph and publishes it; the console subscribes
   over WebSocket. UI state with Zustand, server state with React Query.
2. **API (NestJS)** — Exposes REST (`/workflows`, `/agents`, `/executions`, `/triggers`,
   `/schedules`, `/team`, `/mcp`, `/webhooks`, `/connectors`, `/integrations`…) and the WebSocket
   gateway. The cross-cutting security layers live here: **OIDC/JWT auth**, **RBAC**
   (deny-by-default) and per-workspace **multitenancy** (with optional Postgres RLS,
   `RLS_ENABLED=1`).
3. **Dispatch** — Two modes (`apps/api/src/execution/queue.ts`): `inline` (the engine runs inside
   the API) or `queue` (the API enqueues a **BullMQ** job consumed by the **durable worker** in
   `apps/worker`). The worker is *resume-safe*: if it crashes mid-run, another process picks up
   the job and **skips already-completed nodes (`NodeRun`) without duplicating side effects**.
4. **Engine (`WorkflowRunner`, `packages/engine`)** — The same code in both modes. Validates the
   DAG, schedules nodes, executes **in parallel (fan-out)** with **deterministic fan-in**, and
   applies per-node retries and timeouts. It receives all dependencies via **ports**
   (`packages/engine/src/ports.ts`), never via Nest decorators or Prisma imports.
5. **Nodes** — Each node type is a plugin in `@core/sdk-plugins` (`agent`, `code`, `connector`,
   `download`, `extract`, `human`, `router`, `trigger`). The **Agent** node runs a *tool-calling*
   loop against an LLM; with `isOrchestrator=true` it enters the loop
   `analyze → plan → validate → dispatch sub-DAG → merge`, and the `PlanValidator` de-risks
   invalid plans. Tools and connectors (http, MCP, Slack, Jira, Drive…) are resolved via registry.
6. **Data** — **Postgres** (via Prisma, `@core/infra`) stores the append-only event log, workflow
   versioning (draft → published → archived, with per-execution version pinning) and the
   `NodeRun` records. **Redis** checkpoints the execution context and acts as the pub/sub bus.
7. **Event loop** — Every `ExecutionEvent` the engine emits goes to Redis pub/sub → the WS gateway
   forwards it → the web reduces it with the **same pure reducer** used for replay. That is why
   nodes light up live and replay is deterministic.

## Monorepo structure (pnpm + Turbo)

Follows **Clean / hexagonal architecture**. Boundaries are enforced by `dependency-cruiser`
(`pnpm depcruise`) in CI: `domain` and `engine` cannot import frameworks, ORM or adapters; `web`
never imports the backend core.

| Package / app | Role | Key rule |
|---|---|---|
| `@core/contracts` | Zod schemas, DTOs, events, plugin SPIs | Versioned with **SemVer + changesets**; a breaking change without a bump fails CI |
| `@core/domain` | Pure DAG entities and rules | **No IO, no frameworks** |
| `@core/engine` | `WorkflowRunner` over hexagonal **ports** | **No NestJS/Prisma**; dependencies injected via ports |
| `@core/infra` | Prisma/Redis/BullMQ adapters + `schema.prisma` | Implements the engine ports |
| `@core/sdk-plugins` | Runtime for nodes, tools, connectors, orchestrator | Extensible via **registry (Open/Closed)** |
| `@core/llm` | Provider router (anthropic, openai/groq, mock) | Mock provider by default, no credentials |
| `apps/api` | NestJS: REST + WS gateway, auth, RBAC, tenant, enqueue | Runs the engine in inline/debug mode |
| `apps/worker` | BullMQ process that runs `@core/engine` | No public HTTP; the same engine as the API |
| `apps/web` | React + React Flow + Zustand + React Query | Editor, console, marketplace, integrations |

## Design principles

- **Event sourcing** as the single source of truth: the live console and replay are both
  projections of the same pure reducer shared between client and server.
- **Open/Closed extensibility**: new nodes, tools, connectors or models are added via
  **registry/plugin without touching the runner**, validated by architecture tests.
- **Separate planning from execution**: the Orchestrator only emits a `Plan`; the `PlanExecutor`
  materializes it as a sub-DAG, reusing the engine's retries/timeouts/observability.
- **Idempotent external side effects** (`stepKey`/`idempotencyKey` + transactional outbox) so that
  resume after a crash does not duplicate actions.
- **Security is cross-cutting, not optional**: centralized RBAC (deny-by-default), a secret manager
  with envelope encryption, an immutable audit log, and multitenancy from day one.

## Execution modes (environment variables)

- `DISPATCH` = `inline` (default) | `queue` (requires `docker compose up -d` + `apps/worker`).
- `PERSISTENCE` = `memory` (default, no infra) | `postgres` (Prisma).
- `AUTH_MODE` / `NODE_ENV=production` enable real auth (email+password, scrypt); in prod
  `JWT_SECRET` must be set to your own value or the API refuses to start (fail-closed).
- `RLS_ENABLED=1` mounts the 2nd tenant-isolation barrier (Postgres RLS).
- `EXEC_STEP_DELAY_MS` slows each step down to better see live transitions.

## Deep dives

Per-area documentation lives in [`docs/design/`](design/README.md): architecture and data model,
execution engine, visual editor, agents and Orchestrator, plugins/events, importer and AI
generation, observability/replay/memory, security/RBAC/marketplace, and adversarial review.
Phased plan in [`ROADMAP.md`](../ROADMAP.md); getting started in [`README.md`](../README.md).
