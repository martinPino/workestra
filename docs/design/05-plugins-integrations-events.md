# Diseno detallado: Sistema de Plugins (Tools/Connectors) y Eventos/Triggers

## 1. Objetivo y principios

Este area entrega dos capacidades que deben crecer **solo por adicion de plugins**, sin tocar el motor de ejecucion ni el editor:

1. **Sistema de plugins** para *Herramientas* (Tools) y *Conectores* (Connectors), completamente desacoplado del nucleo.
2. **Sistema de eventos/triggers** que inicia workflows a partir de eventos externos e internos.

Principios rectores (SOLID / Clean Architecture):

- **Inversion de dependencias (DIP):** el nucleo depende de interfaces (`Tool`, `Connector`, `TriggerProvider`) publicadas en un SDK; los plugins concretos dependen del SDK, nunca al reves. El nucleo **jamas** importa `github`, `jira`, etc.
- **Open/Closed:** anadir un tipo de tool, conector o evento es escribir un plugin nuevo. El motor, el `ToolInvoker`, el `EventBus` y el editor permanecen cerrados a modificacion.
- **Frontera unica de seguridad/observabilidad:** todas las llamadas a tools pasan por `ToolInvoker`; todas las acciones de conector por `ConnectorGateway`. Ahi (y solo ahi) se validan permisos, se resuelven secretos, se aplican timeouts/retries y se emiten spans + `ExecutionLog`.
- **Deny-by-default:** un plugin no puede tocar red, disco, procesos ni secretos salvo que declare la *capability* y el agente/workspace se la conceda.

---

## 2. Plugin SPI (`@platform/plugin-sdk`)

Paquete de contratos estables. Unica dependencia del autor de plugins. Versionado por SemVer y expuesto en el manifiesto via `apiVersion`.

### 2.1 Tipos base

```ts
// Identidad y capabilities declarativas (deny-by-default)
export type Capability =
  | 'net:http'            // salida HTTP
  | 'net:egress:*'        // cualquier egress TCP
  | 'fs:read' | 'fs:write'
  | 'exec:process'        // spawnear procesos (docker, terraform)
  | `secret:read:${string}`   // p.ej. 'secret:read:github'
  | 'clock:timers';

export interface ExecutionContext {
  executionId: string;
  workflowVersionId: string;
  nodeId: string;
  workspaceId: string;
  organizationId: string;
  logger: ScopedLogger;          // escribe a ExecutionLog
  signal: AbortSignal;           // cancelacion/timeout
  secrets: SecretAccessor;       // acceso mediado (ver 4.2)
  variables: Readonly<Record<string, unknown>>;
}
```

### 2.2 Interfaz `Tool`

Una tool es una operacion pura-ish con input/output tipados por JSON Schema. No conoce credenciales de conector (eso es del `ExecutionContext.secrets` mediado).

```ts
export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly key: string;                 // 'http.request', 'git.clone'
  readonly inputSchema: JSONSchema;     // validado por ToolInvoker
  readonly outputSchema: JSONSchema;
  readonly requiredCapabilities: Capability[];
  readonly costModel?: CostModel;       // para estimacion de coste/tokens
  invoke(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

export interface ToolContext extends ExecutionContext {
  http: HttpClient;   // solo presente si se concedio net:http
  fs?: FsClient;      // solo si fs:read/fs:write
  proc?: ProcessRunner; // solo si exec:process
}
```

Los clientes (`http`, `fs`, `proc`) **solo se inyectan si la capability fue concedida** (materializado por `CapabilityBroker`). Un plugin sin `net:http` no tiene forma de llamar a la red: no hay `fetch` global en el sandbox.

### 2.3 Interfaz `Connector`

Un conector encapsula: estrategia de auth, catalogo de acciones, y (opcionalmente) un `TriggerProvider` que traduce eventos del proveedor a eventos canonicos.

```ts
export interface Connector {
  readonly key: string;               // 'github', 'jira', 'slack'
  readonly auth: AuthStrategy;        // OAuth2 | ApiKey | Basic | None
  readonly actions: Record<string, ActionHandler>;
  readonly triggers?: TriggerProvider;
}

export interface ActionHandler<I = unknown, O = unknown> {
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  requiredScopes: string[];           // scopes OAuth/permiso del proveedor
  execute(input: I, ctx: ConnectorContext): Promise<O>;
}

export interface AuthStrategy {
  kind: 'oauth2' | 'api_key' | 'basic' | 'none';
  // OAuth2:
  authorizeUrl?(cfg: OAuthConfig): string;
  exchangeCode?(code: string, cfg: OAuthConfig): Promise<TokenSet>;
  refresh?(refreshToken: string, cfg: OAuthConfig): Promise<TokenSet>;
}

export interface TriggerProvider {
  readonly eventTypes: string[];      // ['issue.created','pr.merged',...]
  // Verifica firma del webhook entrante (HMAC, timestamp)
  verify(req: RawWebhookRequest, signingSecret: string): boolean;
  // Normaliza payload del proveedor a evento canonico
  parseEvent(req: RawWebhookRequest): PlatformEvent[];
  // Alta/baja del webhook en el proveedor (idempotente)
  register?(ctx: ConnectorContext, target: WebhookTarget): Promise<{ externalId: string }>;
  unregister?(ctx: ConnectorContext, externalId: string): Promise<void>;
}
```

### 2.4 Manifiesto de plugin

```jsonc
{
  "apiVersion": "1.0",
  "type": "connector",           // o "tool"
  "key": "github",
  "version": "2.3.1",            // SemVer del plugin
  "displayName": "GitHub",
  "entrypoint": "./dist/index.js", // o "oci:registry/github-tool@sha256:..."
  "runtime": "isolated-vm",       // in-process | isolated-vm | container
  "requiredCapabilities": ["net:http", "secret:read:github"],
  "actions": ["issues.create", "pulls.merge", "repos.getContent"],
  "eventTypes": ["issue.created", "issue.updated", "pr.opened", "pr.merged", "commit.pushed"],
  "checksum": "sha256:...",
  "signature": "..."             // firma del autor/marketplace
}
```

---

## 3. Registry, versionado, carga y sandbox

### 3.1 `PluginRegistry`

```ts
interface PluginRegistry {
  register(manifest: PluginManifest, artifact: Artifact): Promise<PluginVersion>;
  resolve(pluginKey: string, range: string): Promise<ResolvedPlugin>; // SemVer
  list(filter: { type?: PluginType; capability?: Capability }): Promise<PluginSummary[]>;
  getActionSchema(pluginKey: string, action: string): Promise<{ input: JSONSchema; output: JSONSchema }>;
}
```

- Persistencia en tablas `Plugin` / `PluginVersion` (ver entidades).
- **Versionado:** SemVer; un `Node` o `TriggerBinding` fija un `range` (`^2.0.0`). `resolve` elige la mayor version publicada compatible.
- **Descubrimiento:** el editor visual consume `list()` para poblar el catalogo de nodos Herramienta/API y de conectores. Los schemas de I/O alimentan la generacion de formularios del nodo.
- **Integridad:** `register` valida `checksum` y `signature` (obligatoria para `visibility=MARKETPLACE`).

### 3.2 `PluginLoader` + `SandboxRuntime`

```ts
interface SandboxRuntime {
  run(plugin: ResolvedPlugin, entry: EntryRef, input: unknown,
      grants: CapabilitySet, limits: ResourceLimits): Promise<Result>;
}
```

Implementaciones y matriz de seleccion (por `manifest.runtime`):

| Runtime | Uso | Aislamiento |
|---|---|---|
| `InProcessSandbox` | tools de 1a parte confiables, baja latencia (HTTP, DB) | worker aislado, sin globals de red |
| `IsolatedVmSandbox` | plugins de marketplace / no confiables | isolated-vm, heap y CPU acotados, sin I/O salvo capabilities |
| `EphemeralContainerSandbox` | Docker, K8s, Terraform, Playwright, Filesystem privilegiado | contenedor efimero, red por politica, FS temporal, kill al terminar |

`ResourceLimiter` aplica `timeout`, `maxMemory`, `maxCpuMs`; `ctx.signal` propaga cancelacion. La red del sandbox es **deny-all** salvo `net:http` (con allowlist de hosts opcional por `PluginGrant.allowedResources`).

---

## 4. Frontera de ejecucion: `ToolInvoker` y `ConnectorGateway`

### 4.1 `ToolInvoker` (unica via de invocacion de tools)

```ts
interface ToolInvoker {
  invoke(ref: { pluginKey: string; range: string; }, input: unknown,
         ctx: ExecutionContext): Promise<ToolResult>;
}
```

Pipeline determinista:

1. `PluginRegistry.resolve` -> version concreta.
2. `SchemaValidator.validate(input, inputSchema)`.
3. `PermissionGuard.assertAllowed(agent, requiredCapabilities, target)`.
4. `CapabilityBroker.grant(granted)` -> `CapabilitySet` con clientes inyectables.
5. `SandboxRuntime.run(...)` con `timeout`/`retry`/`circuit-breaker`.
6. `SchemaValidator.validate(output, outputSchema)`.
7. Emision de span + `ExecutionLog` (input redactado, duracion, coste/tokens si `costModel`).

### 4.2 `ConnectorGateway` (unica via de acciones/triggers de conector)

```ts
interface ConnectorGateway {
  executeAction(ref: ConnectorRef, action: string, input: unknown, ctx: ExecutionContext): Promise<unknown>;
  startOAuth(connectorKey: string, workspaceId: string): { redirectUrl: string; state: string };
  handleCallback(state: string, code: string): Promise<Connector /*persisted*/>;
  refreshIfNeeded(connectorId: string): Promise<void>;
}
```

- **Credenciales just-in-time:** el `Connector` referencia `credentialSecretId`; el gateway resuelve el token via **Secret Manager** justo antes de `execute`, lo pasa por `ConnectorContext.secrets` (accessor que **nunca** expone el ciphertext ni lo persiste en logs). El manifiesto **no** contiene secretos.
- **OAuth2:** `state` firmado (anti-CSRF) con `workspaceId`; `handleCallback` intercambia code por `TokenSet`, cifra y guarda en Secret Manager (`type=OAUTH_TOKEN`), crea/actualiza `Connector` con `status=CONNECTED`.
- **Refresh proactivo:** antes de `expiresAt`; ante fallo -> `status=EXPIRED` y escalado (`work-status=blocked`).
- **Rate-limit** por conector (Redis token-bucket) y `SecretAccessor` con scope por workspace/organizacion.

### 4.3 Modelo de permisos (capabilities)

```ts
interface PermissionGuard {
  assertAllowed(subject: Agent | Workspace, required: Capability[], target?: ResourceRef): void;
}
```

- El **manifiesto declara** `requiredCapabilities`; el `PluginGrant` **concede** un subconjunto a un Agent/Workspace, con `allowedResources` (repos, canales, buckets) para scope fino.
- `CapabilityBroker` materializa solo lo concedido: sin `net:http` -> no hay `ctx.http`; sin `secret:read:jira` -> `ctx.secrets.get('jira')` lanza.
- Cada autorizacion se audita (RBAC + auditoria del area de seguridad).

---

## 5. Sistema de eventos / triggers

### 5.1 Evento canonico (`PlatformEvent`, estilo CloudEvents 1.0)

```ts
interface PlatformEvent {
  id: string;                 // idempotencia global
  type: string;               // 'issue.created' | 'pr.merged' | 'commit.pushed'
                              // | 'cron.fired' | 'manual.trigger' | 'api.trigger'
  source: string;             // 'connector:github' | 'cron' | 'api'
  subject?: string;           // 'repo/owner#123'
  dedupeKey: string;          // derivado del payload (idempotencia)
  data: Record<string, unknown>; // datos normalizados
  occurredAt: string; receivedAt: string;
}
```

El nucleo solo conoce este tipo. El mapeo proveedor -> canonico vive en `TriggerProvider.parseEvent` (en el conector).

### 5.2 Flujo de ingesta (webhook entrante)

```
Proveedor --> POST /webhooks/:connectorId/:webhookId  (WebhookIngress)
  1) Connector.verify(req, signingSecret)   // HMAC + timestamp
  2) responder 2xx ACK inmediato
  3) encolar payload CRUDO en BullMQ 'raw-events'
Worker raw-events:
  4) EventNormalizer -> Connector.parseEvent -> PlatformEvent[]
  5) EventBus.publish(event)
     - Deduplicator.isDuplicate(dedupeKey)?  // Redis SET NX EX (TTL)
     - TriggerMatcher.match(event) -> TriggerBinding[]
     - por cada binding: encolar Execution en BullMQ 'executions' (jobId estable)
```

Claves de correccion:
- **ACK rapido + async** evita timeouts del proveedor (que causan reintentos y duplicados).
- **Dedupe idempotente** (`SET NX EX` sobre `dedupeKey`) absorbe la entrega at-least-once.
- **`jobId` estable** en el encolado de Execution: dedupe tambien aguas abajo.

### 5.3 `EventBus` y `TriggerMatcher`

```ts
interface EventBus {
  publish(event: PlatformEvent): Promise<void>;
  subscribe(pattern: string, handler: (e: PlatformEvent) => Promise<void>): void;
}
interface TriggerMatcher {
  match(event: PlatformEvent): Promise<TriggerBinding[]>; // tipo + filterExpr
}
```

`TriggerBinding.filterExpr` (JSONLogic/CEL) filtra por campos del `data` (p.ej. `data.repo == "core" && data.labels contains "bug"`). El indice se mantiene por `eventType` para matching O(bindings-del-tipo).

### 5.4 `WorkflowTriggerService` (alta/baja de triggers)

```ts
interface WorkflowTriggerService {
  activate(wfVersion: WorkflowVersion, trigger: TriggerNode): Promise<TriggerBinding>;
  deactivate(bindingId: string): Promise<void>;
}
```

Segun el tipo de nodo Trigger:
- **Eventos de conector** (Issue/PR/Commit): registra `Webhook` remoto via `ConnectorGateway`/`TriggerProvider.register` y crea `TriggerBinding` con `connectorId`.
- **Cron:** crea un **BullMQ repeatable job** (`cronExpr`, `repeatJobId` estable) que emite `PlatformEvent{type:'cron.fired'}`; reconciliacion al publicar/despublicar la WorkflowVersion.
- **Manual:** endpoint `POST /triggers/:workflowId/manual` genera `manual.trigger`.
- **API:** `POST /events` (API key) inyecta un evento externo/custom (`api.trigger`).
- **Webhook generico:** endpoint dedicado sin conector, con `signingSecret` propio.

### 5.5 Tipos de evento soportados (inicio de workflow)

`issue.created`, `issue.updated`, `pr.opened`, `pr.merged`, `commit.pushed`, `webhook.generic`, `cron.fired`, `manual.trigger`, `api.trigger`. Cada uno es solo un `PlatformEvent.type`; anadir uno nuevo no toca el motor, solo el `eventTypes` del conector y el catalogo del editor.

---

## 6. Mapa de datos (tablas nuevas de este area)

- **Plugin** / **PluginVersion**: catalogo y versiones (manifiesto, checksum, firma, `requiredCapabilities`, schemas). `PluginVersion.status`: DRAFT/PUBLISHED/DEPRECATED/YANKED.
- **Connector**: instancia por workspace de un `PluginVersion` tipo connector, con `credentialSecretId` y `status` (CONNECTED/EXPIRED/ERROR).
- **Secret** (Secret Manager): ciphertext envelope/KMS, `type` (OAUTH_TOKEN/API_KEY/GENERIC), `meta` (scopes, expiresAt, refreshTokenRef).
- **Webhook**: registro por conector (`externalId`, `signingSecretId`, `eventTypes`).
- **PlatformEvent** (event log): para dedupe, auditoria y **replay** de observabilidad.
- **TriggerBinding**: suscripcion workflowVersion<->eventType(+filtro / cron / connector).
- **PluginGrant**: capabilities concedidas a Agent/Workspace + `allowedResources`.

---

## 7. Como se cumple la extensibilidad "sin tocar el nucleo"

- Nueva **Tool** o **Connector**: implementar el SPI, publicar manifiesto -> aparece en el registry y en el editor. Cero cambios en motor/invoker/bus.
- Nuevo **tipo de evento**: anadirlo a `eventTypes` del conector y al catalogo; el bus y el matcher lo tratan de forma generica.
- Nuevo **runtime de sandbox** o **modelo de IA**: nueva implementacion detras de `SandboxRuntime`/adaptadores; el resto no se entera.
- **Versionado**: SemVer en SPI y plugin; `apiVersion` en el manifiesto; tests de contrato en CI contra plugins de referencia antes de publicar; adaptadores para majors antiguas.

---

## 8. Contratos REST resumidos

- `POST /tools`, `POST /connectors` — instalar/registrar plugin (manifiesto+artifact).
- `GET /plugins?type&capability` — descubrimiento para el editor.
- `GET /connectors/:id/oauth/authorize` / `GET /connectors/:id/oauth/callback` — OAuth2.
- `POST /webhooks/:connectorId/:webhookId` — ingesta de webhooks (HMAC + ACK rapido).
- `POST /triggers/:workflowId/manual` — disparo Manual.
- `POST /events` — inyeccion de evento via API (API key).
- WS `ws://.../executions/:id` — stream de invocaciones de tools/triggers a la consola.

Todos los endpoints de ejecucion emiten `ExecutionLog` y spans, alimentando la observabilidad (tokens, coste, prompts, llamadas a herramientas) y el **replay** paso a paso.
