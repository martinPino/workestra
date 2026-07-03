# Documentación de diseño — Plataforma de Orquestación de Agentes

Generado por diseño multi-agente (8 áreas en paralelo → síntesis → crítica adversarial → pulido).

## Documento principal

- [ROADMAP por fases](../../ROADMAP.md) — plan M0…M12 con dependencias, criterios de aceptación y camino crítico.

## Deep-dives por área

- [Arquitectura global y modelo de datos](01-architecture.md)
- [Motor de ejecución de workflows (DAG)](02-workflow-engine.md)
- [Editor visual (React Flow) — PRIORIDAD](03-visual-editor.md) ⭐
- [Sistema de agentes y Orchestrator — PRIORIDAD](04-agent-orchestrator.md) ⭐
- [Plugins (tools/connectors) y eventos](05-plugins-integrations-events.md)
- [Importador de automatizaciones y generación por IA](06-importer-ai-generation.md)
- [Observabilidad, replay y memoria](07-observability-memory.md)
- [Seguridad/RBAC, API y Marketplace](08-security-marketplace-api.md)
- [Revisión adversarial](09-adversarial-review.md)

⭐ = prioridad explícita del usuario.

## Principios de secuenciación

- Cimientos antes que features: contratos, fronteras Clean Architecture y versionado SemVer se fijan en M0 y se protegen con lint/CI para no reescribir el nucleo
- Walking skeleton vertical temprano (M1): atravesar editor+engine+persistencia+WS con el slice mas fino reduce el mayor riesgo, el de integracion
- De-riesgar las prioridades del usuario pronto: slice usable del Editor en M1-M2 y del Orchestrator en M5, no al final; luego se profundizan
- Separar planificacion de ejecucion: el Orchestrator solo emite un Plan; el PlanExecutor lo materializa como sub-DAG reutilizando la maquinaria del motor (reintentos/timeouts/observabilidad/replay)
- Event log append-only como unica fuente de verdad desde M1: consola en vivo y replay son proyecciones del mismo reducer compartido cliente/servidor
- Extensibilidad por registro (Open/Closed): nuevos nodos, tools, conectores, importadores y modelos se anaden por plugin sin tocar el nucleo, validado con tests de arquitectura
- Seguridad transversal, no opcional: multitenancy, deny-by-default y gate unico de autorizacion existen antes de exponer secretos, sandbox de infra o marketplace
- Lo mas avanzado al final, cimientos desde el inicio: importador amplio, marketplace, memoria vector, replay total y escalado a miles de ejecuciones se dejan tardios, pero sus interfaces base se definen temprano
- Cada fase deja algo demostrable y construye sobre la anterior, respetando dependencias reales entre areas

## Camino crítico

`M0 → M1 → M2 → M3 → M4 → M5 → M6 → M9 → M10`

## Temas transversales

- Versionado de contratos: @core/contracts (SemVer), SPI de plugins (apiVersion) e IR (schemaVersion) tratados como API con contract tests en CI
- Multitenancy y aislamiento: Prisma tenant middleware + RLS + SecurityContext presentes desde M0 y reforzados hasta M10
- Idempotencia de efectos externos: stepKey/idempotencyKey + outbox transaccional aplicados en engine, tools, webhooks y encolado
- Event-sourcing y determinismo del replay: todo efecto no determinista se graba como evento; reducer puro compartido cliente/servidor
- Extensibilidad Open/Closed via registros (NodeRegistry, PluginRegistry, ImporterRegistry, ModelRegistry) con tests de arquitectura que prohiben imports concretos en el nucleo
- Seguridad: RBAC/PolicyEngine centralizado (PDP/PEP), Secret Manager con envelope encryption, deny-by-default en capabilities y sandbox por privilegio, audit log inmutable
- Gestion de coste: CostCalculator con precios versionados + BudgetManager con limites por agente/plan/ejecucion
- Observabilidad: eventos, tokens/coste, prompts, tool-calls, memoria y variables emitidos por todo componente hacia el ExecutionLog
- Escalabilidad: colas BullMQ particionadas, workers stateless, backpressure y fairness multi-tenant, particionado y cold storage del event log
- Redaccion de secretos/PII (PayloadRedactor) y externalizacion de payloads grandes (BlobRefStore) en todo lo que se persiste

