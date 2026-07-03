# Runbook — Backup y restauración (Backup/DR base · M0)

Objetivo de M0: dejar definido y **probado** un procedimiento de backup/restore para el estado con el que ya trabajamos, y anticipar la recuperabilidad del futuro *event store* (ExecutionLog) y de las **KEK** (claves de cifrado del Secret Manager).

## Alcance del estado a proteger

| Sistema | Contenido | Estrategia |
|---------|-----------|------------|
| **PostgreSQL** | Fuente de verdad transaccional: tenants, workflows/versiones, agentes, ejecuciones, `ExecutionLog` (append-only → base del replay) | `pg_dump` lógico diario + PITR (WAL) en producción |
| **Redis** | Context store (checkpoints) y colas BullMQ | AOF (`appendonly yes`) + snapshot RDB; los checkpoints son reconstruibles desde el log |
| **Blob** (futuro) | Artefactos, adjuntos | Versionado del bucket + réplica entre regiones |
| **KEK** (Secret Manager) | Claves maestras de *envelope encryption* | Custodia en KMS/HSM; **sin la KEK los secretos cifrados son irrecuperables** → backup y rotación auditada de la KEK |

> Recuperabilidad del event store: como `ExecutionLog` es append-only, un restore de Postgres a un punto T reconstruye deterministamente el estado de ejecución hasta T (replay). No perder este append-only es prioritario.

## Backup (desarrollo / staging)

```bash
# Postgres (esquema + datos)
docker compose exec -T postgres pg_dump -U agentflow -Fc agentflow > backups/agentflow-$(date +%F).dump

# Redis (fuerza snapshot RDB)
docker compose exec -T redis redis-cli SAVE
docker compose cp redis:/data/dump.rdb backups/redis-$(date +%F).rdb
```

## Restore (procedimiento probado)

```bash
# 1) Levantar infra limpia
docker compose down -v && docker compose up -d

# 2) Restaurar Postgres
docker compose exec -T postgres pg_restore -U agentflow -d agentflow --clean --if-exists < backups/agentflow-<fecha>.dump

# 3) Restaurar Redis (opcional; los checkpoints se reconstruyen)
docker compose cp backups/redis-<fecha>.rdb redis:/data/dump.rdb
docker compose restart redis

# 4) Verificar
docker compose exec -T postgres psql -U agentflow -d agentflow -c "SELECT count(*) FROM \"Execution\";"
pnpm --filter @core/infra prisma:generate
```

## Prueba de restore (criterio de aceptación de M0)

1. `pnpm db:migrate && pnpm db:seed` sobre una base vacía.
2. `pg_dump` → guardar el `.dump`.
3. `docker compose down -v` (destruir el volumen) y `up -d`.
4. `pg_restore` del `.dump`.
5. Confirmar que la org `acme`, el workspace `default` y el workflow "Hola AgentFlow" están presentes.

Si el paso 5 reproduce el estado, el restore es válido.

## Producción (resumen)

- Postgres gestionado con **PITR** (retención ≥ 7 días) + `pg_dump` lógico nocturno a almacenamiento inmutable (object-lock).
- Redis en modo AOF con réplica; las colas se drenan/reintentan por diseño (idempotencia por `stepKey`).
- **KEK**: respaldadas en KMS con versionado; runbook de rotación y ensayo de recuperación trimestral (sin KEK no hay secretos).
- Ensayo de DR (game day) trimestral con RTO/RPO objetivo documentados.
