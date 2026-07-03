# Arquitectura Global y Modelo de Datos

Documento de diseno del area fundacional de la plataforma SaaS de orquestacion de agentes de IA. El objetivo es un nucleo desacoplado, extensible por plugins y escalable a miles de ejecuciones simultaneas, respetando SOLID y Clean Architecture. Las dos prioridades (Editor Visual y Orchestrator) se de-riesgan garantizando que el **motor de ejecucion** y los **contratos** sean estables y agnosticos de framework desde el inicio.

## 1. Layout del monorepo

Se usa **Turborepo + pnpm workspaces** (build cache, task graph, ejecucion incremental) con **TypeScript project references**.

```
repo/
  apps/
    api/            # NestJS: REST + WS gateway, auth, RBAC, adaptadores Prisma, encolado BullMQ
    worker/         # Proceso BullMQ que ejecuta @core/engine (sin HTTP publico)
    web/            # React + React Flow + Zustand + React Query (editor, consola, marketplace)
  packages/
    contracts/      # @core/contracts: Zod schemas, DTOs, eventos WS/REST, SPIs de plugin (SemVer)
    domain/         # @core/domain: entidades y reglas puras (DAG, invariantes). Sin IO
    engine/         # @core/engine: WorkflowRunner sobre puertos hexagonales. Sin NestJS/Prisma
    infra/          # @core/infra: adaptadores Prisma/Redis/BullMQ/KMS que implementan puertos
    sdk-plugins/    # @core/sdk-plugins: runtime de plugins (NodeExecutor/Tool/Connector) + sandbox
  tooling/
    eslint-config/  # reglas comunes + dependency-cruiser (fronteras Clean Architecture)
    tsconfig/
```

**Por que:** un unico repo con paquetes internos versionados permite compartir **tipos** entre backend/engine/frontend sin duplicar, mientras `dependency-cruiser` impone las fronteras. `apps/api` y `apps/worker` comparten `@core/infra` y `@core/engine` pero se despliegan y escalan por separado.

## 2. Descomposicion en modulos (Clean Architecture)

Direccion de dependencias hacia adentro. Regla de oro: **el dominio y el engine no conocen frameworks**.

- **domain** (mas interno): agregados `Workflow`, `WorkflowVersion`, `Node`, `Edge`, `Execution`, `Agent`, `ExecutionContext`; value objects; validaciones `validateDag(nodes, edges)` (aciclicidad, handles validos), `buildExecutionPlan(version)` (orden topologico + ramas). Cero IO.
- **application/engine**: casos de uso de ejecucion. `WorkflowRunner` orquesta el plan, aplica reintentos/timeouts/rollbacks/paralelismo/pausas, emite eventos. Depende **solo** de puertos:

```ts
// @core/engine/ports.ts
export interface IExecutionRepository {
  create(e: NewExecution): Promise<Execution>;
  updateStatus(id: string, s: ExecutionStatus): Promise<void>;
  appendLog(log: NewExecutionLog): Promise<void>;
}
export interface IContextStore {           // Redis en prod, in-memory en test
  load(execId: string): Promise<ExecutionContext>;
  checkpoint(execId: string, ctx: ExecutionContext): Promise<void>;
}
export interface IEventPublisher { publish(e: ExecutionEvent): Promise<void>; }
export interface INodeExecutorRegistry { get(type: NodeType): INodeExecutor; }
export interface ISecretResolver { resolve(ref: SecretRef, scope: PermissionScope): Promise<string>; }
export interface IClock { now(): Date; }
export interface IIdGenerator { next(): string; }
```

- **infrastructure** (`@core/infra` + `apps/api`): adaptadores concretos. `PrismaExecutionRepository implements IExecutionRepository`, `RedisContextStore implements IContextStore`, `RedisPubSubEventPublisher`, `KmsSecretResolver`. NestJS solo aqui, para DI/HTTP/WS.
- **interface**: controladores REST y `WsGateway` en `apps/api`; UI en `apps/web`.

**Desacople del engine respecto a NestJS y al frontend:** el `WorkflowRunner` recibe sus dependencias por inyeccion de puertos (composicion), no por decoradores de Nest. Se instancia igual en `apps/api` (ejecucion inline/debug) y en `apps/worker` (produccion). El frontend nunca importa `@core/engine` ni `@core/infra`; consume unicamente `@core/contracts` (tipos y esquemas Zod). Un lint rule prohibe `@nestjs/*` y `@prisma/client` dentro de `packages/engine` y `packages/domain`.

## 3. Extensibilidad por plugins (Open/Closed)

Anadir un tipo de nodo **no modifica el runner**. El runner resuelve el ejecutor via registro:

```ts
// @core/contracts/spi.ts
export interface INodeExecutor {
  readonly type: NodeType;
  execute(ctx: NodeExecutionContext): Promise<NodeResult>; // { context, next, control }
}
export interface ITool { readonly key: string; readonly idempotent: boolean;
  invoke(input: unknown, auth: ResolvedAuth): Promise<unknown>; }
export interface IConnector { readonly provider: string;
  dispatch(event: ConnectorEvent): Promise<void>; }
export interface IAgentRuntime { invoke(agent: Agent, ctx: ExecutionContext): Promise<AgentResult>; }

export interface PluginManifest {
  key: string; version: string; kind: 'node' | 'tool' | 'connector';
  permissions: PermissionScope[];   // p.ej. ['secrets:read:connector', 'net:egress:github.com']
  provides: { nodes?: NodeType[]; tools?: string[]; connectors?: string[] };
}
```

`@core/sdk-plugins` carga manifests, registra executors y aplica **sandbox** (proceso aislado / isolated-vm, decision abierta) con los permisos declarados. El **Orchestrator** es un `INodeExecutor` mas (`isOrchestrator` en Agent): analiza la tarea del `context`, selecciona agentes, los ejecuta como subworkflows (`parentExecutionId`), fusiona resultados y escala al humano via `IHumanEscalation`. Nunca invoca herramientas tecnicas directamente.

## 4. Modelo de datos Prisma (completo)

Multitenancy por `organizationId`/`workspaceId` en toda entidad operativa. Workflows inmutables via `WorkflowVersion` (snapshot). `ExecutionLog` append-only para replay.

```prisma
model Organization { id String @id @default(cuid()) name String slug String @unique plan String @default("free") createdAt DateTime @default(now()) workspaces Workspace[] memberships Membership[] }
model Workspace { id String @id @default(cuid()) organizationId String org Organization @relation(fields:[organizationId], references:[id]) name String slug String
  workflows Workflow[] agents Agent[] tools Tool[] connectors Connector[] secrets Secret[] prompts Prompt[] memories Memory[] webhooks Webhook[] plugins Plugin[] @@unique([organizationId, slug]) }
model User { id String @id @default(cuid()) email String @unique passwordHash String name String memberships Membership[] }
model Membership { id String @id @default(cuid()) userId String organizationId String workspaceId String? role Role user User @relation(fields:[userId],references:[id]) @@unique([userId, organizationId, workspaceId]) }
enum Role { OWNER ADMIN EDITOR VIEWER }

model Workflow { id String @id @default(cuid()) workspaceId String workspace Workspace @relation(fields:[workspaceId],references:[id]) name String status WorkflowStatus @default(DRAFT) currentVersionId String? versions WorkflowVersion[] executions Execution[] webhooks Webhook[] createdAt DateTime @default(now()) @@index([workspaceId]) }
enum WorkflowStatus { DRAFT ACTIVE ARCHIVED }
model WorkflowVersion { id String @id @default(cuid()) workflowId String workflow Workflow @relation(fields:[workflowId],references:[id]) version Int graphSnapshot Json createdBy String publishedAt DateTime? nodes Node[] edges Edge[] executions Execution[] @@unique([workflowId, version]) }
model Node { id String @id @default(cuid()) workflowVersionId String version WorkflowVersion @relation(fields:[workflowVersionId],references:[id]) type String key String config Json position Json agentId String? toolId String? @@unique([workflowVersionId, key]) }
model Edge { id String @id @default(cuid()) workflowVersionId String version WorkflowVersion @relation(fields:[workflowVersionId],references:[id]) sourceNodeKey String targetNodeKey String sourceHandle String? condition Json? }

model Execution { id String @id @default(cuid()) workflowVersionId String workspaceId String parentExecutionId String? status ExecutionStatus @default(QUEUED) triggerType String context Json tokensUsed Int @default(0) costEstimate Decimal @default(0) startedAt DateTime? finishedAt DateTime? logs ExecutionLog[] version WorkflowVersion @relation(fields:[workflowVersionId],references:[id]) @@index([workspaceId, status]) @@index([parentExecutionId]) }
enum ExecutionStatus { QUEUED RUNNING PAUSED WAITING_HUMAN SUCCEEDED FAILED CANCELLED }
model ExecutionLog { id String @id @default(cuid()) executionId String execution Execution @relation(fields:[executionId],references:[id]) nodeKey String stepKey String level String status String input Json? output Json? prompt Json? modelResponse Json? tokens Int @default(0) cost Decimal @default(0) durationMs Int @default(0) createdAt DateTime @default(now()) @@unique([executionId, stepKey]) @@index([executionId, createdAt]) }

model Agent { id String @id @default(cuid()) workspaceId String name String description String? systemPrompt String model String tools String[] memoryScope String? variables Json? limits Json? permissions Json? isOrchestrator Boolean @default(false) @@index([workspaceId]) }
model Tool { id String @id @default(cuid()) workspaceId String key String pluginId String? schema Json authConfig Json? @@unique([workspaceId, key]) }
model Connector { id String @id @default(cuid()) workspaceId String key String pluginId String? provider String credentialsSecretId String? @@unique([workspaceId, key]) }
model Secret { id String @id @default(cuid()) workspaceId String key String ciphertext String kmsKeyId String version Int @default(1) @@unique([workspaceId, key]) }
model Webhook { id String @id @default(cuid()) workspaceId String workflowId String event String url String signingSecretId String active Boolean @default(true) }
model Memory { id String @id @default(cuid()) workspaceId String scope String ownerId String? key String value Json kind String expiresAt DateTime? @@index([workspaceId, scope, ownerId]) }
model Prompt { id String @id @default(cuid()) workspaceId String name String template String variables Json? version Int @default(1) }
model Plugin { id String @id @default(cuid()) workspaceId String? key String kind String version String manifest Json status String source String @@unique([workspaceId, key, version]) }
```

## 5. Estrategia de escalado (miles de ejecuciones simultaneas)

- **Colas BullMQ particionadas** por tipo: `execution`, `node`, `agent`, `webhook`, `cron`. `apps/worker` es **stateless** y escala horizontalmente (N replicas por cola).
- **Concurrencia y backpressure:** `concurrency` por worker + **rate limiter** por cola y **por tenant** (grupo BullMQ / clave por workspaceId) para evitar que un tenant monopolice. Backpressure natural via profundidad de cola + limites de admision en la API.
- **Idempotencia:** cada paso tiene `stepKey` deterministico (`executionId:nodeKey:attempt`). `ExecutionLog` con `@@unique([executionId, stepKey])` deduplica; herramientas declaran `idempotent` y usan clave de idempotencia hacia sistemas externos (evita crear 2 PRs al reintentar).
- **Checkpointing y context store:** el `context` vive en Redis (`IContextStore.checkpoint`) durante la ejecucion; snapshot a Postgres al pausar/finalizar. Habilita reanudar tras crash del worker y **replay** desde `ExecutionLog`.
- **Reintentos/timeouts/rollbacks:** politica por nodo (backoff exponencial, `maxAttempts`, `timeoutMs`), compensacion (rollback) declarativa por nodo. Pausas manuales -> `WAITING_HUMAN` + evento WS.
- **Particionado de datos:** `ExecutionLog` particionado nativo por rango de tiempo en Postgres + archivado frio; indices por `workspaceId`.

## 6. Decisiones tecnicas y trade-offs

- **Turborepo+pnpm** vs Nx: menor coste conceptual, buen cache; se acepta menos scaffolding que Nx.
- **Versionado de contratos con SemVer + changesets**: eventos WS y DTOs llevan campo `version`; CI valida breaking-changes de esquemas Zod antes de merge. Trade-off: disciplina de release a cambio de estabilidad web/api/engine.
- **Event bus Redis pub/sub -> WS gateway**: simple y suficiente para fan-out de eventos de ejecucion en tiempo real; si crece, migrable a NATS/Kafka sin tocar el engine (solo el adaptador `IEventPublisher`).
- **Engine como paquete puro** (no libreria Nest): mayor testabilidad (adaptadores in-memory), reutilizable en api y worker; coste: composicion manual de dependencias en lugar de DI automatica.
- **Multitenancy por columna + RLS** como default (con schema-per-tenant reservado a enterprise): equilibrio entre operativa simple y aislamiento.
- **Prisma middleware/extension** que exige `workspaceId` + **RLS** como segunda barrera contra fugas entre tenants.

Estas decisiones garantizan que anadir nuevos tipos de nodo, modelos de IA o integraciones se haga por **plugins** sin tocar el nucleo, y que el motor escale horizontalmente de forma independiente del frontend y de NestJS.
