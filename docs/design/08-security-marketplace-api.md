# Diseño de Área: Seguridad/RBAC, API/Contratos y Marketplace

## 0. Alcance y principios

Este documento cubre la **capa transversal de confianza** de la plataforma y su superficie externa:

1. **Multitenancy y RBAC** — jerarquía Organization -> Workspace -> recursos, matriz recurso x acción, aislamiento por tenant.
2. **Secret Manager** — envelope encryption sobre KMS, API keys cifradas, rotación y auditoría.
3. **Audit log inmutable** — registro append-only verificable (hash-chaining).
4. **Superficie de API** — REST versionada + contratos WebSocket, con AuthN/AuthZ, rate limiting e idempotencia.
5. **Marketplace** — publicación/versionado/instalación de agentes, workflows, conectores, herramientas y prompts.

Principios rectores (Clean Architecture + SOLID):

- **PDP/PEP para autorización** (Policy Decision Point / Policy Enforcement Point): la decisión vive en un `PolicyEngine` central; los módulos solo *declaran* qué permiso requieren. Añadir un recurso NO toca el núcleo (OCP).
- **Aislamiento de tenant forzado en la capa de datos**, no confiado a filtros manuales.
- **Secretos por referencia (handle)**: el plaintext nunca cruza el boundary de ejecución.
- **Contratos como fuente de verdad**: DTOs -> OpenAPI/AsyncAPI generados, verificados en CI.

---

## 1. Multitenancy y aislamiento

### 1.1 Jerarquía

```
Organization (tenant raíz, facturación, límites globales)
  └── Workspace (unidad de trabajo, contiene recursos)
        └── Recursos: Agent, Workflow, Connector, Tool, Secret, Webhook, Memory, Prompt, Execution
```

- **Organization**: frontera de facturación, plan y políticas globales. Los `Role` de scope `ORG` viven aquí.
- **Workspace**: frontera operativa. Todo recurso pertenece a exactamente un workspace (`workspaceId` no nulo).
- Un `User` accede vía `Membership`, que lo une a una Organization y opcionalmente a un Workspace, con un `Role`.

### 1.2 Aislamiento de datos

Se fuerza en la **capa de persistencia**, no en cada handler:

```ts
// Contexto de tenant resuelto desde el SecurityContext en cada request
interface TenantScope {
  organizationId: string;
  workspaceId?: string; // presente en operaciones de workspace
}

// Middleware de Prisma que inyecta el filtro en TODA query sobre entidades tenant-scoped
function prismaTenantMiddleware(scope: TenantScope): Prisma.Middleware {
  return async (params, next) => {
    if (isTenantScopedModel(params.model)) {
      injectWhere(params, { organizationId: scope.organizationId, ...(scope.workspaceId && { workspaceId: scope.workspaceId }) });
    }
    return next(params);
  };
}
```

- Base compartida con **row-level scoping** por defecto; **RLS de PostgreSQL** como segunda barrera opcional (`SET app.current_workspace`).
- `TenantScopedRepository<T>` como clase base para repositorios; cualquier acceso fuera de scope es un error de programación, no un permiso denegado.

> Decisión abierta: aislamiento físico (schema/DB por tenant) vs. compartido con RLS — ver Open Questions.

---

## 2. RBAC (Autorización)

### 2.1 Modelo

Matriz **recurso x acción**. Un `Permission` es la tupla canónica `resource:action`.

- **Resources**: `agent`, `workflow`, `workflow_version`, `execution`, `connector`, `tool`, `secret`, `webhook`, `membership`, `role`, `marketplace_listing`, `audit`, `workspace`, `organization`.
- **Actions**: `create`, `read`, `update`, `delete`, `execute`, `publish`, `install`, `rotate`, `manage_members`, `read_audit`.

```ts
type Action = 'create'|'read'|'update'|'delete'|'execute'|'publish'|'install'|'rotate'|'manage_members'|'read_audit';

interface ResourceRef {
  type: string;          // 'workflow', 'secret', ...
  id?: string;           // recurso concreto, o undefined para acciones de colección
  workspaceId?: string;
  organizationId: string;
}

interface Decision {
  allowed: boolean;
  reason?: string;       // para auditoría/debug
  matchedPermission?: string;
}

interface IPolicyEngine {
  can(ctx: SecurityContext, action: Action, resource: ResourceRef): Promise<Decision>;
}
```

### 2.2 Roles de sistema (semilla)

| Role | Scope | Permisos (resumen) |
|------|-------|--------------------|
| `Owner` | ORG | todo, incluido billing, `role:*`, `membership:*` |
| `Admin` | ORG/WORKSPACE | todo salvo billing/borrar org |
| `Editor` | WORKSPACE | CRUD de workflows/agents/connectors/tools, `execution:execute` |
| `Viewer` | WORKSPACE | solo `read` + observabilidad de ejecuciones |
| `Runner` | WORKSPACE | `execution:execute`, `read` (para service accounts/API keys) |

`RolePermission` soporta `effect: ALLOW|DENY` (deny gana) y un `condition` opcional (semilla ABAC futura, p.ej. `{ ownedBy: 'self' }`).

### 2.3 Enforcement (PEP)

Cadena de request: `AuthGuard` (resuelve principal + tenant) -> `PolicyGuard` (consulta `PolicyEngine`) -> handler.

```ts
@RequirePermission('workflow', 'update')
@Patch('/v1/workflows/:id')
updateWorkflow(@Param('id') id: string, @Body() dto: UpdateWorkflowDto) { /* ... */ }
```

El motor de nodos **no conoce RBAC**: recibe un contexto ya autorizado. Añadir un nuevo tipo de recurso = registrar sus `Permission` y anotar sus controllers; cero cambios en el `PolicyEngine`.

---

## 3. Secret Manager

### 3.1 Envelope encryption

```
plaintext ──(AES-256-GCM con DEK)──> ciphertext
DEK ──(KEK del KMS)──> encryptedDek
```

Cada `SecretVersion` guarda `{ ciphertext, encryptedDek, kekId, iv, authTag }`. El plaintext **nunca** se persiste ni sale al cliente.

```ts
interface SecretRef { workspaceId: string; ref: string; } // ref = nombre lógico, p.ej. 'github-token'

interface IKmsProvider {
  encryptDek(dek: Buffer): Promise<{ encryptedDek: Buffer; kekId: string }>;
  decryptDek(encryptedDek: Buffer, kekId: string): Promise<Buffer>;
}

interface ISecretStore {
  put(ref: SecretRef, plaintext: Buffer, meta: SecretMeta): Promise<SecretVersion>;
  getPlaintext(ref: SecretRef, ctx: SecurityContext): Promise<Buffer>; // autorizado + auditado
  listRefs(workspaceId: string): Promise<SecretDescriptor[]>;           // sin valores
}

interface ISecretRotationPolicy {
  rotate(ref: SecretRef): Promise<SecretVersion>; // nueva versión activa, la anterior pasa a RETIRED
}
```

### 3.2 API keys y referencia por handle

- Las credenciales de conectores/herramientas se guardan como secretos; el recurso las referencia por `secretRef`, **nunca** el valor.
- Las **API keys de la plataforma** (`ApiKey`) se almacenan hasheadas (`hashedKey`, `prefix` visible para UX); el valor completo se muestra una sola vez al crearla.

### 3.3 Rotación

- **Rotación de secreto**: nueva `SecretVersion` `ACTIVE`, previa `RETIRED` (descifrable durante ventana de gracia). Auditado.
- **Rotación de KEK**: solo se hace *re-wrap* de las DEK (barato), no se re-cifra el payload. `kekId` por versión permite descifrar con la KEK correcta durante la transición. Job idempotente y auditado.

`getPlaintext` está restringido al boundary de ejecución (workers del motor) y siempre emite un `AuditEvent` de tipo `secret.accessed`.

---

## 4. Audit log inmutable

Append-only con **hash-chaining** por tenant: cada evento encadena el hash del anterior, permitiendo verificar que nadie borró/alteró registros.

```ts
interface AuditEvent {
  id: string;
  tenantId: string;              // organizationId (raíz de la cadena)
  actorId: string;               // user o service principal
  action: string;                // 'rbac.role.updated', 'secret.accessed', 'marketplace.installed'
  resourceRef: ResourceRef;
  metadata: Record<string, unknown>; // redactado, sin secretos
  timestamp: string;
  prevHash: string;              // hash del evento anterior de este tenant
  hash: string;                  // sha256(prevHash + payload canónico)
}

interface IAuditLogger { record(event: Omit<AuditEvent,'id'|'prevHash'|'hash'>): Promise<void>; }
interface IAuditVerifier { verifyChain(tenantId: string, range: TimeRange): Promise<IntegrityReport>; }
```

- `AuditInterceptor` de NestJS registra automáticamente operaciones sensibles (cambios RBAC, accesos a secretos, publicación/instalación de marketplace, borrados).
- Sin `UPDATE`/`DELETE` sobre la tabla (constraint + permisos de DB). Export firmado para cumplimiento.

---

## 5. Superficie de API REST (versionada)

Prefijo estable **`/v1`**. DTOs validados (class-validator) son la fuente de verdad; OpenAPI se genera y se verifica en CI (contract tests).

### 5.1 Endpoints principales

| Recurso | Endpoints |
|---------|-----------|
| Agents | `POST /v1/agents`, `GET /v1/agents`, `GET/PATCH/DELETE /v1/agents/{id}` |
| Workflows | `POST /v1/workflows`, `GET /v1/workflows`, `GET/PATCH/DELETE /v1/workflows/{id}` |
| Versions | `POST /v1/workflows/{id}/versions`, `GET /v1/workflows/{id}/versions`, `GET /v1/workflows/{id}/versions/{semver}` |
| Executions | `POST /v1/executions`, `GET /v1/executions/{id}`, `POST /v1/executions/{id}/replay`, `POST /v1/executions/{id}/cancel` |
| Connectors | `POST /v1/connectors`, `GET /v1/connectors`, `GET/PATCH/DELETE /v1/connectors/{id}` |
| Tools | `POST /v1/tools`, `GET /v1/tools`, `GET/PATCH/DELETE /v1/tools/{id}` |
| Secrets | `POST /v1/secrets` (crea), `POST /v1/secrets/{ref}/rotate`, `GET /v1/secrets` (handles), `DELETE /v1/secrets/{ref}` |
| Webhooks | `POST /v1/webhooks`, `GET /v1/webhooks`, `DELETE /v1/webhooks/{id}` |
| Marketplace | `POST /v1/marketplace/listings`, `GET /v1/marketplace/listings`, `POST /v1/marketplace/listings/{id}/versions`, `POST /v1/marketplace/installations` |
| RBAC/Tenancy | `/v1/orgs`, `/v1/workspaces`, `/v1/roles`, `/v1/memberships`, `/v1/audit` |

### 5.2 Transversales

- **AuthN**: `Authorization: Bearer <jwt>` (OIDC) o `X-Api-Key`. OIDC discovery + `/v1/auth/token`.
- **AuthZ**: `PolicyGuard` por endpoint (sección 2.3).
- **Rate limiting**: token-bucket en Redis por `principalId`+`tenant`; headers `RateLimit-Limit/Remaining/Reset`; `429` con `Retry-After`.
- **Idempotencia**: header `X-Idempotency-Key` en POST no-idempotentes; `IdempotencyRecord` (request hash + response snapshot, TTL). Reintentos devuelven la respuesta original.
- **Errores**: RFC 7807 Problem Details.
- **Paginación**: cursor-based (`?cursor=&limit=`), respuesta `{ data, nextCursor }`.

```jsonc
// Ejemplo de error RFC 7807
{
  "type": "https://api.platform/errors/permission-denied",
  "title": "Permission denied",
  "status": 403,
  "detail": "Requires workflow:update on workspace ws_123",
  "instance": "/v1/workflows/wf_9/",
  "traceId": "..."
}
```

---

## 6. Contratos WebSocket (ejecución/telemetría)

Endpoint `wss://.../v1/ws`. Handshake autenticado con JWT (`?token=` o header). Descrito con **AsyncAPI**.

- **Autorización de suscripción**: `IChannelAuthorizer.canSubscribe(ctx, channel)` valida que el principal pueda leer esa ejecución (misma comprobación que `execution:read`).
- **Canales**: `execution:{executionId}`.
- **Eventos servidor->cliente**:
  - `execution.node.updated` `{ nodeId, status, startedAt, finishedAt }`
  - `execution.log` `{ nodeId, level, message, ts }`
  - `execution.telemetry` `{ nodeId, tokensIn, tokensOut, costUsd, memoryKeys }`
  - `execution.completed` `{ status, error? }`
- **Cliente->servidor**: `subscribe { channel }`, `unsubscribe { channel }`.

```ts
interface WsEnvelope<T> { type: string; channel: string; payload: T; ts: string; }
```

Estos contratos alimentan la **consola de observabilidad** y el **replay** paso a paso (prioridad del producto junto al Orchestrator).

---

## 7. Marketplace

### 7.1 Modelo

Un `MarketplaceListing` publica un artefacto de tipo `agent | workflow | connector | tool | prompt`, con una o más `MarketplaceVersion` (semver).

```ts
type ArtifactType = 'agent'|'workflow'|'connector'|'tool'|'prompt';
type Visibility = 'private'|'org'|'public';

interface MarketplaceListing {
  id: string; artifactType: ArtifactType; ownerId: string; organizationId: string;
  slug: string; visibility: Visibility; latestVersion: string;
}

interface MarketplaceVersion {
  id: string; listingId: string; semver: string;
  manifest: PluginManifest;           // metadata + permisos requeridos + compat
  payloadRef: string;                 // artefacto serializado (secretos como referencias, nunca valores)
  platformCompatRange: string;        // '>=1.4.0 <2.0.0'
}
```

### 7.2 Publicación e instalación

```ts
interface IMarketplaceCatalog {
  publish(listing: NewListing, version: NewVersion, visibility: Visibility): Promise<MarketplaceVersion>;
  search(query: string, scope: TenantScope): Promise<MarketplaceListing[]>; // respeta visibilidad
}

interface ICompatibilityChecker { check(v: MarketplaceVersion, platformVersion: string): CompatResult; }

interface IInstallationService {
  install(listingVersionId: string, target: TenantScope): Promise<InstalledArtifact>;
}
```

- **Instalar** materializa una **copia local** del artefacto en el workspace destino (no una referencia viva), para que el usuario la edite (importador/edición).
- El `PluginManifest` declara **permisos requeridos** y credenciales necesarias; al instalar se validan contra el RBAC del workspace y se solicitan/mapean `secretRef` locales (nunca se importan secretos del origen).
- `ICompatibilityChecker` rechaza versiones incompatibles con la plataforma (`platformCompatRange`).
- Publicación e instalación se **auditan**; los payloads públicos pasan escaneo de secretos.

### 7.3 Contratos de plugin (extensibilidad OCP)

El paquete compartido `PluginContracts` define las SPIs que hacen que herramientas/conectores del marketplace se integren **sin tocar el núcleo**:

```ts
interface PluginManifest {
  key: string; version: string;            // semver del plugin
  platformCompatRange: string;
  requiredPermissions: string[];           // p.ej. ['secret:read','tool:execute']
  requiredSecrets: { ref: string; description: string }[];
}

interface IToolPlugin {
  manifest: PluginManifest;
  execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>;
}

interface IConnectorPlugin {
  manifest: PluginManifest;
  dispatch(event: ConnectorEvent, ctx: ConnectorContext): Promise<void>;
}
```

---

## 8. Cómo esto respeta la extensibilidad del producto

- **Nuevo recurso o tipo de nodo**: registra sus `Permission` y anota controllers; el `PolicyEngine` no cambia.
- **Nueva herramienta/conector**: implementa `IToolPlugin`/`IConnectorPlugin` + `PluginManifest`; se publica/instala vía Marketplace; el motor lo carga por contrato.
- **Nuevo KMS/BYOK**: implementa `IKmsProvider`; el `SecretManager` no cambia.
- **Nueva versión de API**: `/v2` coexiste con `/v1`; DTOs versionados evitan breaking changes en SDKs/plugins.

---

## 9. Dependencias entre milestones (resumen)

`M1 (tenancy+authn)` -> `M2 (rbac)` -> `M3 (secretos)` -> `M4 (audit)` -> `M5 (REST)` -> `M6 (WS)`; en paralelo tras M4/M5: `M7 (rotación)`; y `M8 (marketplace catálogo)` -> `M9 (instalación+plugins)` que consume todo el stack de seguridad. Esto de-riesga primero identidad/aislamiento (base de todo), luego autorización y secretos (sin los cuales conectores reales no son seguros), y deja el marketplace completo para el final por depender de la superficie de API y del RBAC estables.
