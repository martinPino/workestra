# AgentFlow

Plataforma SaaS de **orquestación de agentes de IA** con **editor visual de workflows**. Un agente líder (Orchestrator) coordina agentes especializados para resolver tareas automáticamente, sobre un motor de ejecución en forma de DAG, extensible por plugins y escalable a miles de ejecuciones simultáneas.

> Estado: **M4 durable + M4p** ✅ sobre Postgres/Redis reales + **UI premium**. El motor despacha en **paralelo** (fan-out) con **fan-in determinista**, reintentos y timeouts; y en modo `DISPATCH=queue` encola en **BullMQ** con un **worker durable** que persiste en Postgres, checkpointa el contexto en Redis y **reanuda tras una caída sin duplicar efectos** (verificado: matar el worker a mitad → otro lo completa; el nodo ya ejecutado no se repite). Versionado **draft → published → archived** con **pin de versión por ejecución**. La web es una app multi-pantalla premium (design system dark/light, sidebar colapsable, **Command Palette ⌘K**, Dashboard, editor con **Publicar**). Ver el plan en [`ROADMAP.md`](./ROADMAP.md).

**Modos de despacho:** `inline` (por defecto, ejecuta en la API) o `DISPATCH=queue` (encola en BullMQ; requiere `docker compose up -d` + `apps/worker`). Persistencia: `PERSISTENCE=memory` (por defecto) o `postgres`. Ambos verificados con datos reales.
>
> _Pendiente de M4 (requiere infra levantada): resume tras caída con BullMQ, `TimerService` durable, outbox transaccional, nodo Bucle y `CancellationController`._

**Orchestrator (M3b):** el nodo Agente con `isOrchestrator=true` ejecuta el bucle `analizar → planificar → validar (re-prompt acotado) → despachar sub-DAG → fusionar`, emitiendo eventos `plan.created`/`subtask.*`/`results.merged` que el reducer proyecta como árbol de subtareas. El `PlanValidator` de-riesga el riesgo #1 (planes inválidos).

**Agentes (M3):** `GET/POST /agents` gestiona el registro; el nodo Agente resuelve `config.agentId` y ejecuta un bucle de tool-calling contra tools **no peligrosas** (`mock`, `http` con allowlist) autorizadas por el RBAC de M0. Proveedor por defecto: Mock (sin credenciales). Con `ANTHROPIC_API_KEY` se activa el adaptador real.

**Atajos del editor:** `⌘Z`/`⇧⌘Z` deshacer/rehacer · `⌘C`/`⌘V` copiar/pegar · `Supr` eliminar · arrastrar desde la paleta · botón *Layout* para auto-organizar · *500 nodos* para probar el presupuesto de rendimiento.

## Demo M1 (walking skeleton)

```bash
pnpm install && pnpm build
# API (in-memory, sin Postgres) + web
API_PORT=3001 PERSISTENCE=memory node apps/api/dist/main.js &   # o: pnpm --filter @app/api dev
pnpm --filter @app/web dev                                       # http://localhost:5173
```

En la web: arrastra nodos desde la paleta, conéctalos y pulsa **Ejecutar**; los nodos se colorean en vivo (amber = ejecutando, verde = ok) a partir del stream de `ExecutionEvent` reducido en el cliente.

- **Persistencia:** `PERSISTENCE=memory` (por defecto) corre sin infraestructura. `PERSISTENCE=postgres` usa Prisma/Postgres (`docker compose up -d && pnpm db:migrate && pnpm db:seed`).
- **Velocidad de paso:** `EXEC_STEP_DELAY_MS` (ms por nodo) para ver mejor las transiciones en vivo.

## Estructura del monorepo

```
apps/
  api/       NestJS: REST + WS gateway, auth (OIDC/JWT), RBAC, tenant, encolado BullMQ
  worker/    Proceso BullMQ que ejecuta @core/engine (sin HTTP público)
  web/       React + React Flow + Zustand + React Query (editor, consola, marketplace)
packages/
  contracts/    @core/contracts   Zod schemas, DTOs, eventos, SPIs de plugin (SemVer)
  domain/       @core/domain      Entidades y reglas puras (DAG). Sin IO
  engine/       @core/engine      WorkflowRunner sobre puertos hexagonales. Sin NestJS/Prisma
  infra/        @core/infra       Adaptadores Prisma/Redis/BullMQ + schema de datos
  sdk-plugins/  @core/sdk-plugins Runtime de plugins (NodeExecutor/Tool/Connector)
tooling/        Config compartida (tsconfig, eslint)
```

Las **fronteras Clean Architecture** las impone `dependency-cruiser` (`pnpm depcruise`): `domain` y `engine` no pueden importar frameworks, ORM ni adaptadores; `web` nunca importa el core de backend.

## Requisitos

- Node **>= 22**, `pnpm` 10 (`corepack enable`)
- Docker (Postgres + Redis) para desarrollo completo

## Puesta en marcha

```bash
corepack enable
pnpm install
cp .env.example .env

# infra local
docker compose up -d          # postgres + redis
pnpm db:generate
pnpm db:migrate
pnpm db:seed

pnpm dev                      # api (3001) + web (5173) + worker
```

## Scripts

| Script | Descripción |
|--------|-------------|
| `pnpm dev` | Levanta api + web + worker en modo desarrollo |
| `pnpm build` | Build de todos los paquetes/apps (turbo, incremental) |
| `pnpm typecheck` | Typecheck de todo el monorepo |
| `pnpm depcruise` | Gates de arquitectura (Clean Architecture) |
| `pnpm test` | Tests (vitest) |
| `pnpm verify` | build + typecheck + lint + depcruise + test |

## Fronteras de la arquitectura

- El **motor** (`@core/engine`) recibe sus dependencias por **inyección de puertos**, no por decoradores de Nest. Se instancia igual en `apps/api` (inline/debug) y `apps/worker` (producción).
- Añadir un **tipo de nodo, herramienta o conector** se hace por **registro/plugin** sin tocar el runner (Open/Closed).
- Los **contratos** (`@core/contracts`) se versionan con **SemVer + changesets**; un breaking change sin bump rompe CI.
