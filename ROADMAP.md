# Roadmap por Fases — Plataforma SaaS de Orquestación de Agentes de IA

> Versión final del arquitecto líder. Incorpora y resuelve la crítica adversarial (sequencing, completeness, priority-derisking). Documento accionable, orientado a construcción incremental con demostrabilidad continua.

---

## 1. Resumen ejecutivo

Construimos una plataforma de orquestación de agentes de IA con dos prioridades explícitas del usuario: **(P1) el Editor Visual** y **(P2) el Orchestrator de agentes**. El principio rector es **de-riesgar ambas prioridades temprano y en paralelo**, no solo la primera.

Frente al borrador, esta versión corrige tres clases de errores:

1. **Contradicciones de secuenciación.** El borrador declaraba "event log como fuente de verdad desde M1" pero no diseñaba el contrato de evento ni el reducer determinista hasta M6. Aquí, el **contrato `ExecutionEvent` versionado y el `ExecutionStateReducer` puro compartido nacen en M1**, y la disciplina de determinismo se impone en M3–M4, de modo que todos los emisores nacen correctos. M6 queda reducido a **proyecciones/UI** (consola, scrubber, snapshots), no rediseño de contrato.

2. **Asimetría de de-riesgado entre P1 y P2.** El Orchestrator estaba encadenado detrás del motor durable completo (M4), llegando a mitad de proyecto. Aquí introducimos un **walking skeleton del Orchestrator en M3b** (Planner + validador de Plan + PlanExecutor secuencial sobre el runner de M3), que valida el **riesgo existencial de P2** —que el LLM produzca planes inválidos/cíclicos/no ejecutables— semanas antes, en un **track paralelo** al motor durable. M5 pasa a ser el **endurecimiento** del Orchestrator (durabilidad del sub-DAG, escalado humano, handoff), no su primera aparición.

3. **Fases sobrecargadas y dependencias falsas.** M8/M9/M10 combinaban 3–4 subsistemas cada una. Se **parten** en unidades entregables; se corrigen dependencias reales (M8 depende de idempotencia/outbox de M4, no solo de M5; la memoria persistente se adelanta a M3 para que el replay de M6 ya la contemple); y se **distribuyen a fases tempranas** los transversales que no pueden esperar al final: **RBAC mínimo, publicación/versionado de workflows, dry-run/test de workflows, monitoring operativo, backup/DR y un hito de integración** antes de producción.

El resultado son **15 fases** (M0–M12 con desdoblamientos a/b), con dos tracks paralelos formalizados (LLM/Orchestrator y Seguridad/API), un camino crítico con ramas reales, y una fase de integración que evita el big-bang de convergencia.

---

## 2. Principios de secuenciación

1. **Cimientos antes que features.** Contratos (`@core/contracts`), fronteras Clean Architecture y SemVer se fijan en M0 y se protegen con dependency-cruiser + breaking-change check en CI. Ningún rediseño de núcleo posterior.
2. **Walking skeleton vertical temprano (M1).** Atravesar todas las capas cuanto antes reduce el mayor riesgo: la integración end-to-end.
3. **De-riesgar AMBAS prioridades pronto y en paralelo.** Slice usable del Editor en M1–M2 **y** slice caminante del Orchestrator en M3b, no al final. El riesgo LLM→Plan se valida en cuanto existe `LLMProvider`, sin esperar al motor durable.
4. **El contrato de evento y el reducer determinista son artefactos de primera clase desde M1.** El `ExecutionEvent` se versiona (`schemaVersion`) desde el nacimiento; el reducer es puro (sin `Date.now()`/random, impuesto por lint/test). M6 solo añade proyecciones/UI.
5. **Separar planificación de ejecución.** El Orchestrator solo emite un `Plan`; el `PlanExecutor` lo materializa como sub-DAG reutilizando la misma maquinaria del motor (reintentos/timeouts/observabilidad/replay).
6. **Determinismo del replay grabado, no re-ejecutado.** Todo efecto no determinista (salida de LLM, resultado de tool, timestamps, semillas) se graba como evento; el replay reconstruye desde el log, nunca re-invoca modelos ni tools.
7. **Extensibilidad por registro (Open/Closed).** Tipos de nodo, herramientas, conectores, importadores y modelos se añaden por plugin/registro **incremental** sin tocar el núcleo. Registrar "los 11 tipos de golpe" está prohibido: cada tipo entra en la fase que trae su runtime.
8. **Seguridad transversal, no opcional.** RBAC mínimo viable, multitenancy deny-by-default y un gate único de autorización existen **antes** de exponer capacidades peligrosas (secretos, sandbox, conectores, marketplace). El sandbox mínimo precede a la ejecución de tools reales por el Orchestrator.
9. **Operabilidad SaaS no se difiere al final.** Publicación/versionado de workflows, dry-run/test, monitoring/alerting, metering y backup/DR se secuencian donde son necesarios, no en la última fase.
10. **Convergencia sin big-bang.** Un hito de integración explícito junta las ramas paralelas (memoria, plugins, eventos, núcleo) antes de la fase de producción a escala.

---

## 3. Tabla resumen de fases

| ID | Objetivo | Tamaño | Depende de |
|----|----------|--------|------------|
| **M0** | Scaffolding: monorepo, contratos, CI, auth, RBAC mínimo, backup/DR base | L (3-4 sem) | — |
| **M1** | Walking skeleton vertical: editor↔engine↔WS + contrato `ExecutionEvent` + reducer puro | L (4-5 sem) | M0 |
| **M2** | Editor usable (P1): CommandBus/undo-redo, registro incremental de nodos, schema-driven, DAG guard | L (4-5 sem) | M1 |
| **T-LLM** | *(track paralelo)* Capa de proveedores LLM: provider/router/cost/adapters | M (3-4 sem) | M0 |
| **M3** | Runtime de agentes: nodo Agente, tools autorizadas, memoria (temporal+persistente) con eventos | L (5-6 sem) | M2, T-LLM |
| **M3b** | Walking skeleton del Orchestrator (P2): Planner + validador de Plan + PlanExecutor secuencial | M (3-4 sem) | M3 |
| **M4** | Motor durable: paralelismo, fan-in, resume, idempotencia+outbox, timers | L (6-7 sem) | M3 |
| **M4p** | Publicación/versionado de workflows: draft/published/archived, pin por ejecución | M (2-3 sem) | M2 (converge con M4) |
| **M5** | Orchestrator endurecido: sub-DAG durable, selección pluggable, escalado humano, handoff | L (5-6 sem) | M3b, M4 |
| **M6** | Observabilidad y replay determinista: consola, scrubber, snapshots, redacción; dry-run/test de workflows | L (5-6 sem) | M5 |
| **M7** | Memoria avanzada: vector/semántica, conversacional, retención/GDPR-shredding | M (4-5 sem) | M3 (profundiza tras M6) |
| **M8a** | Plugins y sandbox: SPI congelado, `PluginRegistry` firmado, `CapabilityBroker`, sandbox por privilegio | L (5-6 sem) | M3 |
| **M8b** | Eventos, triggers y conectores: WebhookIngress durable, EventBus/dedupe, conectores de referencia | L (5-6 sem) | M4, M8a |
| **M9a** | Saga/compensación + subworkflows | M (4-5 sem) | M4, M5 |
| **M9b** | Creación asistida: IR + importador base (JSON, n8n) + generación IA + exportación | L (5-6 sem) | M2, M6 |
| **M10** | Hito de integración: memoria+plugins+eventos+núcleo end-to-end; monitoring/alerting de plataforma | M (3-4 sem) | M7, M8b, M9a |
| **M11** | Escala y hardening: colas segregadas, fairness, particionado, carga; RBAC avanzado/ABAC, audit hash-chained, rotación KEK; metering/cuotas | L (6-8 sem) | M10 |
| **M12** | Cobertura amplia y marketplace: catálogo completo tools/connectors/importadores, marketplace firmado | L (6-8 sem) | M9b, M11 |

> Productividad del canvas (copy/paste, grupos, comentarios, minimapa, auto-layout) se **cuelga de M2** como incrementos, no de M9. Un presupuesto de rendimiento del canvas con grafo grande sintético (500+ nodos) es criterio de aceptación de M2.

---

## 4. Detalle por fase

### M0 — Scaffolding y cimientos transversales
**Objetivo.** Fijar fronteras, contratos y seguridad base que no se reescribirán.
**Scope.** Turborepo+pnpm con `apps/{api,web,worker}` y `packages/@core/{contracts,domain,engine,infra,sdk-plugins}`. tsconfig references. dependency-cruiser (el `engine` no importa NestJS/Prisma/proveedores). changesets/SemVer para contratos. Zod inicial. Prisma multitenant mínimo + RLS. Auth OIDC/JWT + tenant middleware. **RBAC mínimo viable** (roles fijos owner/admin/editor/viewer + scopes por recurso) como servicio consumible desde el inicio. **Backup/DR base**: definición de backup/restore de Postgres/Redis/blob, prueba de restore, atención a recuperabilidad del futuro event store y a las KEK. Requisitos base de a11y (navegación por teclado del canvas) e i18n de UI declarados para evitar retrofit.
**Entregables.** Monorepo con gates de arquitectura en CI; login OIDC; migraciones+seed multitenant con RLS; `RbacService` con roles fijos; runbook de backup/restore probado.
**Criterios de aceptación.** Un import prohibido rompe el build; un breaking change de contrato sin bump de SemVer rompe CI; restore de un backup de prueba reconstruye el estado; una llamada sin scope es denegada por `RbacService`.
**Riesgos.** Sobre-ingeniería de contratos → limitar M0 a lo estrictamente compartido y versionable.

### M1 — Walking skeleton vertical + contrato de evento
**Objetivo.** Atravesar todas las capas con el slice más fino y fijar el contrato de telemetría correctamente **la primera vez**.
**Scope.** React Flow + Zustand + 3 nodos base (Trigger/Log/Fin) + persistencia de `WorkflowVersion` inmutable. Puertos del engine + compiler DAG mínimo + **scheduler cuyo contrato asume múltiples nodos listos a la vez** (aunque despache secuencialmente) + worker BullMQ. **`ExecutionEvent` append-only versionado (`schemaVersion`) como artefacto de primera clase** + **`ExecutionStateReducer` puro compartido cliente/servidor** + `TelemetryGateway` WS que pinta estado por nodo como **proyección del reducer**.
**Entregables.** Demo end-to-end (dibujar→ejecutar→ver en vivo); paquete `@core/contracts` con `ExecutionEvent` y el reducer; modelo `NodeRun`.
**Criterios de aceptación.** Round-trip del editor sin pérdida; ciclos rechazados por el compiler; **el scheduler expone "nodos listos" como conjunto, no como siguiente-único** (test); el estado en vivo se deriva 100% del reducer puro (sin lógica de estado ad-hoc en el gateway).
**Riesgos.** Contrato de evento/reducer mal fijado → mitigado al convertirlo en entregable diseñado contra requisitos de replay desde ya; scheduler secuencial que no anticipa concurrencia → mitigado por el contrato "nodos listos" y por documentar que M4 solo cambia la política de despacho.

### M2 — Editor usable (Prioridad 1)
**Objetivo.** Editor profesional, fluido y de-riesgado a escala.
**Scope.** CommandBus con undo/redo determinista (`apply∘invert=identidad`), selección múltiple. `NodeTypeRegistry` con **registro incremental**: en M2 solo se registran tipos con runtime existente o trivial (Trigger/Log/Condición/HTTP/Fin). `NodePropertiesPanel` generado desde JSON Schema. `EdgeValidator`/DAG guard con `CycleIndex` incremental. En el engine, `NodeRegistry` (Strategy) + primeros executors reales como plugins (Condición, HTTP). Productividad de canvas (copy/paste, grupos, comentarios, minimapa, auto-layout) como incrementos. **Presupuesto de rendimiento con grafo grande sintético (500+ nodos)**.
**Entregables.** Editor con undo/redo, panel schema-driven, validación DAG incremental, minimapa/agrupado.
**Criterios de aceptación.** `apply∘invert=identidad` verificado por property test; **añadir un tipo de nodo nuevo no toca el núcleo** (test de arquitectura); el grafo es siempre DAG válido; **render y `CycleIndex` cumplen el presupuesto con 500+ nodos**.
**Riesgos.** Especular sobre configSchemas de nodos sin runtime → evitado por registro incremental; rendimiento a escala descubierto tarde → mitigado por el presupuesto en M2.

### T-LLM — Capa de proveedores LLM *(track paralelo, arranca tras M0)*
**Objetivo.** Desacoplar el runtime de agentes de proveedores concretos y no serializar trabajo independiente del editor.
**Scope.** `LLMProvider` (OpenAI/Anthropic/Mock), `ModelRegistry`, `ModelRouter`, `CostCalculator` con **precios versionados**, salida estructurada (JSON schema/tool-calling). Equipo separado, sin dependencia del editor ni del compiler.
**Entregables.** Paquete de proveedores intercambiable por config; adaptador Mock determinista para tests/replay.
**Criterios de aceptación.** Cambiar de proveedor por config sin tocar consumidores; `CostCalculator` reproducible con precios versionados.
**Riesgos.** Deriva de contrato con M3 → contract tests compartidos.

### M3 — Runtime de agentes (+ memoria con eventos)
**Objetivo.** Nodo Agente ejecutando tool-calling autorizado y con memoria que ya emite eventos al log.
**Scope.** `AgentRegistry`. `ToolAuthorizationService` (deny-by-default, **consume el RBAC de M0**, no un stub) + `ToolInvoker` + herramientas base **restringidas a un conjunto no peligroso** (Mock/HTTP a allowlist) hasta que M8a aporte sandbox. `AgentRuntime` como nodo Agente con tool-calling real y guardrails mínimos. **`MemoryStore` (puerto) + backends temporal (Redis) y persistente (Postgres) adelantados aquí**, emitiendo eventos al log desde su nacimiento. Memoria conversacional/de sesión con política básica de ventana de contexto (truncado + resumen incremental).
**Entregables.** Nodo Agente funcional; `MemoryStore` con dos backends; eventos de agente y de memoria en el log.
**Criterios de aceptación.** Nodo Agente ejecuta solo tools autorizadas por RBAC; proveedor LLM intercambiable por config; **la memoria persistente emite eventos** de modo que el replay de M6 pueda reconstruirla; herramientas peligrosas explícitamente **no** habilitadas todavía (documentado en scope).
**Riesgos.** Ejecutar tools sin aislamiento → mitigado restringiendo el catálogo a no peligroso hasta M8a.

### M3b — Walking skeleton del Orchestrator (Prioridad 2) *(converge desde track LLM)*
**Objetivo.** Validar el riesgo existencial de P2 —planes inválidos/cíclicos/no ejecutables— **sin esperar al motor durable**.
**Scope.** Agente líder que emite un `Plan` (DAG de subtareas) con **salida estructurada del LLM**. `PlanValidator`: aciclicidad, existencia de agentes/tools referenciados, presupuesto factible. `PlanExecutor` **secuencial** que materializa el plan como sub-DAG sobre el scheduler de M1/runner de M3 (sin durabilidad ni paralelismo). Re-prompt acotado ante plan inválido, medido contra un set de tareas reales. Vista básica del árbol de subtareas (co-requisito de observabilidad para depurar planes).
**Entregables.** Demo: tarea en lenguaje natural → Plan validado → 2-3 subtareas ejecutadas por agentes reales → resultado fusionado. Métrica de tasa de planes válidos sobre el set de tareas.
**Criterios de aceptación.** Plan cíclico o con agente/tool inexistente es **rechazado**; el Orchestrator descompone→selecciona→materializa un sub-DAG demostrable; el árbol de subtareas es observable en vivo.
**Riesgos.** Salida estructurada poco fiable → descubierto **aquí** (semana ~13-18), no a mitad de proyecto; se decide re-prompt/repair o cambio de estrategia antes de invertir en M5.

### M4 — Motor durable
**Objetivo.** Confiabilidad y escala del motor.
**Scope.** Colas BullMQ particionadas. Fan-out/fan-in con `ContextManager` copy-on-write y `MergePolicy` determinista. Resume tras caída. **`idempotencyKey` + outbox transaccional** (consumible como sub-hito temprano por M8b). `TimerService` para esperas/timeouts/backoff. `CancellationController`. Se registran los nodos cuyo runtime nace aquí (Espera/Bucle).
**Entregables.** Motor durable con fan-in determinista, resume e idempotencia; nodos Espera/Bucle.
**Criterios de aceptación.** Matar y reiniciar el worker completa la ejecución **sin duplicar efectos**; fan-in determinista; esperas durables tras reinicio; el contrato del scheduler de M1 no cambia, solo su política de despacho.
**Riesgos.** Idempotencia incompleta → herramientas declaran idempotencia; outbox obligatorio para efectos externos.

### M4p — Publicación y versionado de workflows *(converge con M4)*
**Objetivo.** Cerrar el hueco operativo SaaS de ciclo de vida de versiones.
**Scope.** Estado `draft/published/archived` por `WorkflowVersion`. **Pin de versión por ejecución**: una ejecución encolada corre contra la versión con la que arrancó. Política de migración de ejecuciones en vuelo. Promoción entre entornos (dev/staging/prod).
**Entregables.** Publicación de versión activa; ejecuciones ancladas; promoción entre entornos.
**Criterios de aceptación.** **Editar y publicar un workflow no altera ejecuciones ya encoladas** contra la versión previa; el replay de M6 usa la versión anclada.
**Riesgos.** Ejecuciones huérfanas tras archivar → tombstoning con retención mínima.

### M5 — Orchestrator endurecido (Prioridad 2)
**Objetivo.** Profundizar el Orchestrator ya validado en M3b con durabilidad y coordinación completa.
**Scope.** `PlanExecutor` que materializa el sub-DAG **durable** (reintentos/resume/paralelismo del motor de M4). `AgentSelectionStrategy` pluggable. `HumanEscalation` (nodo Humano suspende/reanuda, **consume RBAC/aprobaciones de M0**). `HandoffService` con context-slicing (**sobre el `MemoryStore` real de M3**). `PendingReview` con timeout. Nodo Humano registrado aquí.
**Entregables.** Orchestrator multi-agente durable con escalado humano y handoff.
**Criterios de aceptación.** Descompone→selecciona→ejecuta sub-DAG durable con reintentos; plan inválido rechazado (heredado de M3b); escalado humano suspende/reanuda respetando RBAC; handoff usa memoria compartida real, no efímera.
**Riesgos.** Depurar coordinación a ciegas → mitigado porque el event log del plan y el árbol de subtareas ya existen desde M3b.

### M6 — Observabilidad, replay determinista y dry-run
**Objetivo.** Operabilidad y depuración; **solo proyecciones/UI**, no rediseño de contrato.
**Scope.** Consola de ejecución completa. `SnapshotManager` + `ReplayService` (modo dry) sobre el `ExecutionEvent`/reducer **ya congelados en M1**. Scrubber de replay sincronizado con overlay React Flow contra la `WorkflowVersion` inmutable anclada. Contabilidad de tokens/coste. `PayloadRedactor` + `BlobRefStore`. **Dry-run/test de workflows del usuario**: ejecución en modo simulación con `ToolInvoker` en modo mock, datos de entrada de ejemplo y asserts sobre el resultado (reutiliza el motor).
**Entregables.** Consola + replay time-travel + dry-run con mocks.
**Criterios de aceptación.** Estado-vivo y replay coinciden (property tests); **replay reconstruye artefactos y memoria sin re-ejecutar side-effects**; coste correcto; sin fugas PII; el usuario puede probar un workflow nuevo con tools mockeadas antes de publicarlo.
**Riesgos.** Descubrir campos faltantes en el evento → minimizado porque el contrato nació contra requisitos de replay en M1.

### M7 — Memoria avanzada
**Objetivo.** Calidad de agentes y cumplimiento, sobre el puerto ya correcto.
**Scope.** Backend **vector/semántico (pgvector)** sobre el `MemoryStore` de M3. Memoria compartida con concurrencia controlada. Memoria conversacional avanzada (resumen/compactación de historia larga, anclaje de mensajes clave). `RetentionPolicyEngine`. **GDPR/crypto-shredding** vía claves por-tenant sobre el event log append-only + export de datos del tenant.
**Entregables.** Memoria semántica, retención, borrado por tenant.
**Criterios de aceptación.** Agentes recuperan memoria semántica; **el replay de M6 ya la contempla** (puerto emitía eventos desde M3); shared sin sobreescrituras; borrado por-tenant efectivo vía shredding sin romper el append-only.
**Riesgos.** Tensión append-only vs borrado → resuelta por crypto-shredding.

### M8a — Plugins y sandbox
**Objetivo.** Aislamiento **antes** de exponer herramientas peligrosas.
**Scope.** SPI congelado + `PluginRegistry` firmado. `CapabilityBroker`/`PermissionGuard` completo. **Sandbox por privilegio** (isolated-vm / contenedor efímero) con límites de recursos y allowlist de red/fs. Habilitación de herramientas peligrosas (Git/Filesystem/Docker) **solo tras el sandbox**.
**Entregables.** Registro de plugins firmado; sandbox operativo; catálogo de tools peligrosas habilitado con aislamiento.
**Criterios de aceptación.** Un plugin sin capability es denegado y auditado; una tool peligrosa solo corre dentro del sandbox; añadir una tool no toca el núcleo.
**Riesgos.** Escape de sandbox → pruebas de aislamiento + límites duros.

### M8b — Eventos, triggers y conectores
**Objetivo.** Disparadores e integraciones sobre idempotencia real.
**Scope.** **Depende de M4 (idempotencyKey+outbox)** además de M8a. `WebhookIngress` **durable**: persiste el evento crudo antes del ACK y reprocesa. `EventNormalizer` + `EventBus`/dedupe. `TriggerMatcher` para todos los eventos: Issue Created/Updated, PR Opened/Merged, Commit, Webhook, **Cron recurrente + schedule puntual (one-shot at datetime)**, **trigger encadenado workflow→workflow (vía EventBus interno)**, Manual, API. Estrategia de reintento/backfill ante caída del ingress. `ConnectorGateway` + Secret Manager + OAuth2 con conectores de referencia (GitHub/Slack).
**Entregables.** Ingesta durable de eventos; catálogo de triggers; conectores de referencia con secretos just-in-time.
**Criterios de aceptación.** Webhook duplicado no dispara doble ejecución; Cron sin solapamientos (`jobId` estable); un evento recibido durante caída del ingress no se pierde (persistido pre-ACK); añadir un conector no toca el núcleo.
**Riesgos.** Dedupe sobre motor sin outbox → **evitado** al declarar dependencia real de M4.

### M9a — Saga y subworkflows
**Objetivo.** Compensación y composición del motor.
**Scope.** `CompensationManager` (LIFO) + subworkflows como extensión pura del motor (M4/M5).
**Entregables.** Sagas con compensación LIFO; subworkflows anidados.
**Criterios de aceptación.** Un fallo dispara compensaciones en orden LIFO; un subworkflow ejecuta y reporta al padre.
**Riesgos.** Compensaciones no idempotentes → reutilizan outbox de M4.

### M9b — Creación asistida (importador base + generación IA + exportación)
**Objetivo.** Creación asistida sobre el `NodeRegistry` y el `GraphValidator`, no sobre la saga.
**Scope.** IR canónica + pipeline compartido (`IrToGraphMapper`/`GraphValidator`/`AutoLayout`/`ImportReport`). Importadores JSON propio + n8n. `WorkflowGenerationService` (botón "Generate Workflow") con schema derivado del `NodeTypeRegistry` y guardrails/auto-reparación. **Exportación al JSON canónico propio con round-trip garantizado** (workflow-as-code/GitOps), reutilizando la IR. **Biblioteca de plantillas de ejemplo** (acelera adopción y prueba el importador). Si la generación toca memoria semántica, **declara dependencia de M7**.
**Entregables.** Importar JSON/n8n → DAG editable; generar desde lenguaje natural; exportar a JSON canónico; plantillas.
**Criterios de aceptación.** Import produce DAG válido + `ImportReport` sin pérdida; generación IA sin alucinación estructural (todo nodo/edge validado contra el registro); **round-trip export→import sin pérdida**; import y generación IA comparten pipeline.
**Riesgos.** Deriva entre schema del registro y generación → schema derivado, no hardcoded.

### M10 — Hito de integración + monitoring operativo
**Objetivo.** Converger las ramas paralelas **antes** de producción y cerrar el hueco de MONITORING.
**Scope.** Validación end-to-end **memoria (M7) + plugins/eventos (M8b) + saga/subworkflows (M9a) + núcleo**. **Monitoring de plataforma**: métricas (Prometheus/OTel), **tracing distribuido de una ejecución multi-agente**, alertas configurables por tenant (fallo, coste sobre umbral, colas saturadas, SLA de aprobación humana vencido), y **notificación al owner** (email/Slack/webhook) cuando una ejecución queda `blocked`/`failed`.
**Entregables.** Suite de integración cross-rama; stack de métricas/tracing/alertas; notificaciones al owner.
**Criterios de aceptación.** Un flujo que use memoria semántica + conector + subworkflow + saga corre end-to-end sin fugas cross-tenant; una ejecución fallida genera alerta y notifica al owner; el tracing reconstruye la traza multi-agente.
**Riesgos.** Convergencia big-bang → **evitado** por ser un hito de integración dedicado, no la fase final.

### M11 — Escala, hardening y metering
**Objetivo.** Validar rendimiento y seguridad avanzada **antes** de la fase final de catálogo, cuando el volumen de event log ya es real.
**Scope.** Colas segregadas, fairness multi-tenant, particionado de `execution_events` por tiempo, cold storage, virtualización/culling del canvas, **pruebas de carga a miles de ejecuciones**. Seguridad avanzada: **RBAC custom/ABAC** (extiende el mínimo de M0), auditoría **hash-chained**, rotación KEK sin downtime, idempotency de operaciones sensibles. **Metering/cuotas**: agregación de uso por org, enforcement de límites de plan con backpressure/rechazo controlado, hooks para proveedor de billing, `BudgetManager` con reserva y límites duros por agente/plan/ejecución.
**Entregables.** Plataforma que sostiene miles de ejecuciones con fairness; RBAC/ABAC + audit inmutable + rotación KEK; metering con cuotas.
**Criterios de aceptación.** Miles de ejecuciones con fairness en prueba de carga; auditoría verificable y rotación KEK **sin downtime ni backups indescifrables**; superar la cuota de un plan aplica backpressure/rechazo controlado; canvas fluido con grafos grandes.
**Riesgos.** Refactor de núcleo forzado por escala tardía → mitigado porque el particionado se valida aquí (volumen real) y no en la última fase; contrato de eventos ya soporta versionado desde M1.

### M12 — Cobertura amplia y marketplace
**Objetivo.** Amplitud de catálogo y reutilización, sobre cimientos ya endurecidos.
**Scope.** Catálogo completo de tools (Git, GitHub, GitLab, Jira, Slack, Teams, Docker, Kubernetes, AWS, Azure, Terraform, Playwright, DB, Filesystem, HTTP) y conectores (Jira, GitHub, GitLab, Slack, Discord, Teams, Notion, Confluence, Google Drive, Gmail, Outlook). Importadores adicionales (Mermaid, BPMN, LangGraph, CrewAI, Jira Automation) sobre la IR de M9b. **Marketplace** publicar/instalar de agentes, workflows, conectores, tools y prompts con **firma y compat SemVer**.
**Entregables.** Catálogo completo; importadores adicionales; marketplace firmado.
**Criterios de aceptación.** Publicar→instalar del marketplace respeta permisos/compat SemVer y firma; cada importador nuevo produce DAG válido + `ImportReport`; añadir tool/conector/importador no toca el núcleo.
**Riesgos.** Superficie de seguridad del marketplace → deny-by-default, sandbox de M8a, firma obligatoria, secretos just-in-time.

---

## 5. Camino crítico

**Núcleo de producto (cadena estricta):**
`M0 → M1 → M2 → M3 → M3b → M5 → M6 → M9b → M12`

**Ramas paralelas formalizadas:**
- **T-LLM** arranca tras **M0** (equipo separado) y converge en **M3**. Extraerla evita serializar trabajo independiente del editor.
- **Track Orchestrator (P2):** mientras el equipo A profundiza el motor durable **M4**, el equipo B construye **M3b** (Planner+validador+PlanExecutor secuencial) sobre el runner de M3. Convergen en **M5**. Esto da a P2 paralelización equilibrada frente a P1.
- **M4p** (publicación de versiones) corre en paralelo a M4 y converge con él.
- **M7** (memoria avanzada) es rama que profundiza tras M6; su puerto ya nació en M3.
- **M8a → M8b** es rama que arranca tras M3 (sandbox) y M4 (idempotencia para M8b).
- **M9a** (saga/subworkflows) cuelga de M4/M5.

**Convergencia controlada:** **M10** es el hito de integración que junta M7 + M8b + M9a + núcleo **antes** de la fase de escala. **M11** (escala/seguridad/metering) precede a **M12** (catálogo/marketplace), de modo que el rendimiento y la seguridad avanzada se validan sobre volumen real y no en la última fase.

**Diferencias clave frente al borrador:** el Orchestrator (P2) se de-riesga en **M3b** (semana ~13-18) en lugar de M5 (~24-31); la observabilidad no rediseña contrato (nace en M1); M8/M9/M10 se parten; RBAC, publicación, dry-run, monitoring, backup/DR y un hito de integración se distribuyen a fases tempranas/intermedias.

---

## 6. Riesgos transversales principales

- **Acoplamiento del núcleo** a NestJS/Prisma/proveedores → interfaces + tests de arquitectura (dependency-cruiser) desde M0.
- **Contrato de evento/reducer reescrito para replay** → `ExecutionEvent` versionado + reducer puro como entregable de M1, diseñado contra requisitos de replay; determinismo impuesto por lint/test en M3–M4.
- **Idempotencia de efectos externos** (PR, deploy, Slack) → `idempotencyKey` + outbox desde M4; M8b depende explícitamente de M4; herramientas declaran idempotencia.
- **Determinismo del replay** → grabar todo efecto no determinista como evento; nunca re-ejecutar LLM/tools; reducer sin `Date.now()`/random.
- **Asimetría de de-riesgado P1/P2** → M3b + track Orchestrator paralelo equilibran la validación de ambas prioridades.
- **Coste descontrolado multi-agente** → `BudgetManager` con reserva y límites duros; `CostCalculator` con precios versionados; enforcement de cuotas en M11.
- **Seguridad antes de capacidades peligrosas** → RBAC mínimo en M0; sandbox (M8a) precede a tools peligrosas; tools de M3–M5 restringidas a no peligrosas.
- **Fugas cross-tenant** → Prisma tenant middleware + RLS + fuzzing multi-tenant; validado en el hito de integración M10.
- **Volumen de eventos/almacenamiento** → batch, snapshots, particionado por tiempo (validado en M11 sobre volumen real), blob store, cold storage.
- **Convergencia big-bang** → hito de integración M10 dedicado antes de producción.
- **Recuperabilidad de datos** → backup/restore probado desde M0; crypto-shredding compatible con backups (KEK) en M7/M11.
- **Versionado de contratos/SPI/IR** → SemVer + `schemaVersion`/`apiVersion` + contract tests en CI.

---

## 7. Definición de Done por fase

- **M0**: CI verde con gates de frontera; un import prohibido rompe el build; login OIDC funcional; migraciones+seed multitenant con RLS; `RbacService` deniega sin scope; restore de backup de prueba reconstruye estado.
- **M1**: demo end-to-end (dibujar→ejecutar→ver en vivo); round-trip del editor sin pérdida; ciclos rechazados por el compiler; scheduler expone "nodos listos" como conjunto; estado en vivo derivado 100% del reducer puro; `ExecutionEvent` versionado en `@core/contracts`.
- **M2**: `apply∘invert=identidad` (property test); añadir un tipo de nodo sin tocar el núcleo; grafo siempre DAG válido; render y `CycleIndex` cumplen el presupuesto con 500+ nodos.
- **T-LLM**: proveedor intercambiable por config; Mock determinista; `CostCalculator` reproducible con precios versionados.
- **M3**: nodo Agente ejecuta tool-calling autorizado por RBAC; proveedor LLM intercambiable; memoria persistente emite eventos reconstruibles por replay; tools peligrosas no habilitadas (documentado).
- **M3b**: tarea NL → Plan validado → sub-DAG de 2-3 subtareas ejecutado; plan cíclico/con referencias inexistentes rechazado; árbol de subtareas observable; métrica de tasa de planes válidos sobre set real.
- **M4**: matar y reiniciar el worker completa la ejecución sin duplicar efectos; fan-in determinista; esperas durables tras reinicio.
- **M4p**: editar y publicar un workflow no altera ejecuciones ya encoladas contra la versión previa; replay usa versión anclada.
- **M5**: Orchestrator descompone→selecciona→ejecuta sub-DAG **durable** con reintentos; escalado humano suspende/reanuda respetando RBAC; handoff usa memoria compartida real.
- **M6**: estado-vivo y replay coinciden (property tests); replay reconstruye artefactos y memoria sin re-ejecutar side-effects; coste correcto; sin fugas PII; dry-run con tools mockeadas ejecuta un workflow nuevo antes de publicar.
- **M7**: agentes recuperan memoria semántica; replay reconstruye memoria; shared sin sobreescrituras; borrado por-tenant vía crypto-shredding sin romper append-only.
- **M8a**: plugin sin capability denegado y auditado; tool peligrosa solo corre dentro del sandbox; añadir tool no toca el núcleo.
- **M8b**: webhook duplicado no dispara doble ejecución; Cron sin solapamientos (`jobId` estable); evento recibido durante caída del ingress no se pierde; añadir conector no toca el núcleo.
- **M9a**: fallo dispara compensaciones LIFO; subworkflow ejecuta y reporta al padre.
- **M9b**: import produce DAG válido + `ImportReport` sin pérdida; generación IA sin alucinación estructural; round-trip export→import sin pérdida; import y generación IA comparten pipeline.
- **M10**: flujo memoria+conector+subworkflow+saga end-to-end sin fugas cross-tenant; ejecución fallida genera alerta y notifica al owner; tracing reconstruye la traza multi-agente.
- **M11**: miles de ejecuciones con fairness en prueba de carga; auditoría verificable y rotación KEK sin downtime; superar cuota de plan aplica backpressure/rechazo controlado; canvas fluido con grafos grandes.
- **M12**: publicar→instalar del marketplace respeta permisos/compat SemVer y firma; cada importador nuevo produce DAG válido + `ImportReport`; añadir tool/conector/importador no toca el núcleo.
