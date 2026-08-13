# Migración a Cloudflare

Re-plataforma de Workestra desde Railway (contenedores Node) a Cloudflare (Workers, Workflows,
Durable Objects, Hyperdrive, R2, Containers). **La migración está hecha**; este documento conserva el
razonamiento —qué se cambió por qué, y qué se decidió NO hacer— y lo que queda para servir producción.

> Arquitectura y flujo de ejecución: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Por qué es viable

La arquitectura hexagonal hizo la mayor parte del trabajo. `@core/engine` depende **solo** de los
puertos de `packages/engine/src/ports.ts`, y los adaptadores concretos están aislados en
`@core/infra`. Migrar salió siendo **escribir adaptadores nuevos y una cáscara HTTP nueva**: el motor,
el dominio, los contratos y el router de LLM no se tocaron ni una línea.

| Paquete | Líneas | Cambios |
|---|---|---|
| `@core/contracts` | 1.286 | **Ninguno** — Zod puro |
| `@core/domain` | 964 | **Ninguno** — sin IO |
| `@core/engine` | 1.224 | **Ninguno** — solo puertos |
| `@core/llm` | 683 | **Ninguno** — ya usa `fetch` |
| `@core/infra` | 3.754 | Adaptadores nuevos (los de Prisma/Redis se conservan para dev local) |
| `@core/sdk-plugins` | 8.691 | 3 nodos (`code`, `browser`, `extract`); el resto ya es `fetch` |
| `apps/api` | 7.457 | Capa HTTP reescrita (Hono); los servicios se conservan |
| `apps/worker` | 1.126 | **Retirado**, sustituido por Workflows |
| `apps/web` | 17.953 | Solo el cliente WebSocket |

(Cifras de antes de empezar; el reparto de cambios se mantuvo.)

## Mapa de la plataforma destino

```
                         ┌─────────────────────────────────────────┐
Navegador ──────────────▶│ Worker `web` (Assets)  SPA + fallback    │
                         └─────────────────────────────────────────┘
                                        │ fetch / WebSocket
                         ┌──────────────▼──────────────────────────┐
                         │ Worker `api` (Hono)                     │
                         │  auth JWT · RBAC · tenant · REST        │
                         └──┬─────────┬──────────┬─────────────┬───┘
                            │         │          │             │
              Hyperdrive ───┘         │          │             └─── R2 (ficheros, 48 h)
                 │                    │          │
            Postgres            Durable Object   Workflow `execution`
          (event log,          `ExecutionRoom`   (durable · resume-safe)
           versiones,          WS + pub/sub          │
           NodeRun)            + checkpoint          └──▶ Container `runtime` (fase 5)
                                                          code · browser · OCR
```

| Antes | Ahora | Puerto que implementa |
|---|---|---|
| SPA en contenedor | Worker + Assets | — |
| NestJS + Express | Worker + Hono | — |
| socket.io gateway | Durable Object + WebSocket hibernation | `IEventPublisher` |
| Redis pub/sub `exec:*` | El mismo Durable Object | `IEventPublisher` |
| `RedisContextStore` | DO storage | `IContextStore` |
| `RedisFileStore` (TTL 48 h) | R2 + lifecycle rule | `IFileStore` |
| `RedisWorkspaceUsageRepository` | DO storage, poda al escribir | `IWorkspaceUsageRepository` |
| BullMQ cola `execution` | Cloudflare Workflows | — |
| BullMQ cola `schedule` | Cron Trigger (tick minutal) | `IScheduleRepository` |
| Prisma + Postgres directo | Prisma + `@prisma/adapter-pg` + Hyperdrive | todos los `Prisma*Repository` |
| `nodemailer` (SMTP) | API HTTP (Resend/SES) | `IEmailService` |
| `worker_threads` + `vm` | Container `runtime` | nodo `code` |
| `playwright-core` local | Container `runtime` (o engine `browserbase`) | `BrowserEngine` |
| `tesseract.js` + `pdf-parse` | Container `runtime` | nodo `extract` |

## Límites de plataforma que condicionan el diseño

Verificados en agosto 2026. **Estos números mandan sobre cualquier decisión de abajo.**

**Workers** — 128 MB de memoria por isolate; bundle 10 MB gzip (plan de pago); CPU 30 s por defecto,
configurable hasta 5 min; wall-clock sin límite mientras el cliente siga conectado; 10.000
subrequests por invocación. Cron Triggers, consumidores de cola y alarms de DO: 15 min.

**Workflows** — 10.000 steps por instancia (ampliable a 25.000); **wall-clock por step ilimitado**;
`sleep` hasta 365 días; resultado de step máximo 1 MiB; estado persistido 1 GB; retención 30 días;
50.000 instancias concurrentes.

Dos consecuencias de diseño, no negociables:

1. **El resultado de cada step va a 1 MiB.** El `ExecutionContext` crece con las salidas de los nodos,
   así que **no** viaja entre steps: vive en el Durable Object de la ejecución y los steps solo mueven
   el `executionId`. Es el mismo patrón que ya usaba `FileRef` para no meter bytes en el contexto.
2. **5 min de CPU es el techo real de un nodo.** Un nodo agente que espera al LLM no consume CPU
   (es IO), así que cabe de sobra. Lo que no cabe es OCR de un PDF grande ni un Playwright local:
   por eso van a Container.

## Estado

| Fase | Estado |
|---|---|
| 1 — `web` a Workers Assets | **Hecha** |
| 2 — Adaptadores en `@core/infra` | **Hecha**, con tests contra bindings falsos |
| 3 — `api` a Hono sobre Workers | **Hecha** salvo `/mcp` y `/analytics` (501) |
| 4 — Ejecución a Workflows + Cron | **Hecha.** BullMQ y `apps/worker` retirados |
| 5 — `code`/`browser`/OCR a Containers | **Imagen escrita, sin desplegar.** El binding va comentado en `wrangler.jsonc` |

Railway queda retirado: se borran `Dockerfile`, `railway.json`, `DEPLOY.md`, `scripts/start.sh`,
`apps/web/serve.mjs` y `apps/worker`.

### Lo que falta para servir producción

1. **Provisionar** en Cloudflare: `wrangler hyperdrive create` (y pegar el id), el bucket
   `workestra-files` **con su lifecycle rule**, y los secretos (`JWT_SECRET`, `KMS_MASTER_KEY`,
   `BREVO_API_KEY`/`RESEND_API_KEY`, los `*_CLIENT_SECRET`).
2. **`/mcp`** — el SDK usa el transporte Streamable HTTP sobre `IncomingMessage`/`ServerResponse` de
   Node. Portarlo pide un transporte nuevo sobre `Request`/`Response`; no es un cambio de import.
3. **`/analytics`** — sin portar, sin más motivo que no haber llegado.
4. **Fase 5** — construir y publicar la imagen de `containers/runtime`, y descomentar el binding.
5. **Rate limiting de verdad** — el middleware cuenta por isolate, no globalmente, así que en
   Cloudflare es más débil que en Railway. La barrera real son WAF o Rate Limiting Rules;
   **configúralas antes de abrir el dominio**.
6. **Tests en `workerd`** — mover `apps/api` y `@core/infra` a `@cloudflare/vitest-pool-workers`.

Sobre el punto 6, la lección llegó dos veces en esta migración: `pnpm verify` daba verde mientras el
Worker **no empaquetaba** (NestJS entero colado en el bundle por un import de `PERSISTENCE`), y el
contenedor DI de Nest se rompió sin que ningún test lo notara. Hasta que los tests corran en `workerd`,
`wrangler deploy --dry-run` —ya en CI— es la única red.

## Fases

Cada fase es un despliegue independiente y reversible.

### Fase 1 — `web` a Workers Assets

Mueve el SPA. Sin dependencias con el resto: la web sigue apuntando al API de Railway vía
`VITE_API_URL`.

- `apps/web/wrangler.jsonc` con `assets.not_found_handling = "single-page-application"` (el SPA usa
  `react-router`; sin esto, recargar `/console/abc` da 404).
- Workflow de deploy en Actions, calcado del de `landing/`, que ya despliega a Cloudflare Pages.
- **Gotcha:** `VITE_API_URL` se hornea en build. El workflow debe pasarlo como variable de repo, no
  como secreto de Wrangler (los secretos de Worker son runtime; esto es build-time).

Rollback: apuntar el DNS de vuelta a Railway.

### Fase 2 — Adaptadores Cloudflare en `@core/infra`

Sin desplegar nada todavía: se escriben los adaptadores contra los puertos que ya existen, con sus
tests. Los adaptadores Prisma/Redis actuales **se conservan** — siguen siendo el camino de `pnpm dev`
sin infra en la nube.

- `HyperdrivePrismaClient` — `@prisma/adapter-pg` sobre el binding de Hyperdrive. Requiere subir a
  Prisma 6 y activar `driverAdapters`. La `schema.prisma` y las migraciones **no cambian**: sigue
  siendo el mismo Postgres (Neon/Supabase), solo cambia el transporte.
- `R2FileStore` — implementa `IFileStore`. El TTL de 48 h deja de ser código y pasa a ser una
  lifecycle rule del bucket.
- `DurableObjectContextStore` — implementa `IContextStore` contra el DO de la ejecución.
- `DurableObjectEventPublisher` — implementa `IEventPublisher`; sustituye a `RedisEventPublisher`.
- `createHttpEmailService` — los proveedores de correo por HTTP (Brevo/Resend), separados del
  camino SMTP. `nodemailer` abre un socket SMTP y Workers no da TCP crudo salvo `connect()`.

Los adaptadores de Prisma se reexportan tal cual desde `@core/infra/postgres`: son portables porque
solo hablan con el `PrismaClient` que se les inyecta. Al separarlos salió un dato que conviene
registrar — **`ioredis` nunca llega a un bundle**: los adaptadores de Redis lo importan solo como
tipo (`import type`), así que se borra al compilar. El único import de Node en tiempo de ejecución
de todo `@core/infra` es `nodemailer`.

**Nada de esto toca el motor.** Es la prueba de que la arquitectura aguanta: si un adaptador nuevo
exige cambiar `packages/engine`, es que el puerto estaba mal.

### Fase 3 — `api` a Hono sobre Workers

La fase cara: 88 ficheros. La estrategia es **conservar los servicios y tirar la cáscara**.

- Los `*.service.ts` pasan de clases `@Injectable()` a clases planas. Sus dependencias ya entran por
  constructor, así que el cambio es quitar el decorador y construirlas a mano.
- `buildPersistence()` pasa de factory de módulo Nest a factory por petición, ligada a `env`.
- Controllers → rutas Hono. `JwtAuthGuard` global → middleware. `TenantMiddleware` → middleware.
- `TelemetryGateway` (socket.io) → Durable Object `ExecutionRoom` con `WebSocketPair` y hibernation.
  El catch-up desde `events.list()` se conserva tal cual: es lo que hace el replay determinista.
- **`apps/web` cambia aquí**: `socket.io-client` sale, entra `WebSocket` nativo. El protocolo de
  socket.io no es HTTP+WS estándar y los DO no lo hablan.

**Gotcha grande:** `CLAUDE.md` avisa de que `pnpm verify` no levanta el contenedor DI de Nest. Al
salir Nest ese fallo desaparece, pero llega otro peor: **`workerd` no es Node**. Los tests de
`vitest` en Node dejan de ser evidencia suficiente para `apps/api` y `@core/infra`; hay que moverlos
a `@cloudflare/vitest-pool-workers` o se repite el patrón de «verde en CI, crash-loop en prod».

`RLS_ENABLED` merece revisión aparte: hoy la 2ª barrera de tenant fija el tenant por transacción
desde un `AsyncLocalStorage`. Con Hyperdrive hay pooling por delante, así que el `SET LOCAL` debe ir
dentro de la misma transacción que la consulta o la barrera no aplica. Es exactamente el fallo
silencioso que `buildPersistence()` ya evita al arrancar (`RLS_ENABLED requiere DATABASE_URL_RLS`),
y hay que mantener esa comprobación fail-closed.

### Fase 4 — Ejecución a Workflows

Retira `apps/worker` y BullMQ.

- Un `WorkflowEntrypoint` por ejecución. `WorkflowRunner` se conserva **entero**: lo que cambia es
  quién le da la vuelta al bucle. Cada nodo se envuelve en un `step.do(nodeKey, …)`, que aporta
  reintentos y durabilidad — reemplazando la lógica de reintentos por nodo del runner, no
  duplicándola.
- El resume-safe deja de depender de saltar `NodeRun` completados: Workflows ya no re-ejecuta un step
  cerrado. La proyección `NodeRun` se mantiene porque la consola la lee, pero deja de ser el
  mecanismo de idempotencia.
- El nodo `human` pasa a ser `step.waitForEvent()`. Hoy es una pausa con checkpoint en Redis y una
  reanudación manual; con Workflows es una espera nativa de hasta 365 días. **Es la mayor
  simplificación de toda la migración.**
- Schedules: un Cron Trigger cada minuto que lee `schedules.listActive()` y despacha. Los sondeos de
  Drive/Sentry (`firePollTrigger`) se portan tal cual — ya son polling con cursor.

**Gotcha:** el cursor de sondeo de Drive vive hoy en Postgres y sobrevive a los despliegues
(commit `ef6fe89`). Al portar hay que conservar esa semántica o el primer disparo re-procesa el
histórico entero.

### Fase 5 — `code`, `browser` y OCR a Containers

Los tres nodos que no caben en un isolate.

- **`code-node.ts`** — hoy `worker_threads` + `vm.runInNewContext` con `env: {}`, límite de memoria y
  timeout. En Workers no hay `vm` ni `eval`. Va a **Cloudflare Sandboxes** (GA desde abril de 2026),
  que da exactamente el aislamiento que el comentario del fichero describe. Las garantías de
  seguridad se conservan: sin red, sin acceso a los secretos del proceso, con timeout.
- **`browser`** — el engine `browserbase` sigue funcionando desde un Worker (CDP saliente). El engine
  local `playwright` pasa a Browser Rendering.
- **`extract`** — `tesseract.js` con los ~8,5 MB de `*.traineddata` no cabe en un bundle de 10 MB, y
  el OCR contra 5 min de CPU es apretado. Va al Container, con los traineddata en R2.

Containers y Sandboxes están GA sobre el plan Workers Paid ($5/mes), facturados por 10 ms activos.

## Variables de entorno y bindings

En Workers los recursos entran por **bindings** (`env.DB`, `env.FILES`), no por URL. Lo que queda
como variable es solo la configuración:

```jsonc
// wrangler.jsonc (api)
{
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id>" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "workestra-files" }],
  "durable_objects": { "bindings": [{ "name": "EXECUTION_ROOM", "class_name": "ExecutionRoom" }] },
  "workflows": [{ "binding": "EXECUTION", "name": "execution", "class_name": "ExecutionWorkflow" }],
  "triggers": { "crons": ["* * * * *"] }
}
```

Secretos (`wrangler secret put`): `JWT_SECRET`, `KMS_MASTER_KEY`, `SLACK_CLIENT_SECRET`,
`JIRA_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`, la API key del email.

`KMS_MASTER_KEY` **debe ser el mismo valor que en Railway** durante la convivencia: cifra los tokens
de conectores con AES-GCM y un valor distinto los deja indescifrables. Es el único dato que no se
puede regenerar sin que los usuarios tengan que reconectar sus integraciones.

`PERSISTENCE` y `DISPATCH` desaparecen en el destino: en Workers siempre es Postgres + Workflows. Se
conservan para `pnpm dev`.

## Lo que NO se migra

- **Postgres** sigue siendo Postgres gestionado (Neon/Supabase) detrás de Hyperdrive. D1 es SQLite:
  obligaría a reescribir `schema.prisma` y todas las migraciones, y a perder los tipos JSON del event
  log. No compensa.
- **El adaptador `memory`** (`PERSISTENCE=memory`) se queda. Es lo que hace que `pnpm dev` arranque
  sin infra y no tiene sentido portarlo.

## Orden de corte

1. Fase 1 en producción. La web sirve desde Cloudflare, el API sigue en Railway.
2. Fases 2 y 3 desplegadas a un subdominio (`api-cf.workestra.*`) con la **misma** base de datos.
   Convivencia real: los dos backends leen el mismo Postgres.
3. Se mueve `VITE_API_URL` al Worker. Railway sigue levantado.
4. Fase 4: se apaga `apps/worker` de Railway cuando Workflows procese una ejecución completa en prod.
5. Fase 5: se apaga el servicio `api` de Railway.

El punto de no retorno es el 4: mientras BullMQ y Workflows puedan procesar la misma cola, hay dos
consumidores compitiendo. **Hay que apagar el worker de Railway antes de encender el Workflow**, no
después.
