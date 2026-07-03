#!/usr/bin/env sh
# Arranque de la API en producción: aplica migraciones y luego escucha.
# `migrate deploy` es idempotente (no hace nada si no hay migraciones pendientes).
set -e
echo "→ Aplicando migraciones (prisma migrate deploy)…"
pnpm --filter @core/infra run prisma:deploy
# Seed idempotente: crea el workspace por defecto `ws_dev` (necesario por la FK de Workflow) + org,
# owner y agentes demo. No-fatal: si fallara, la API igual arranca (se puede re-sembrar a mano).
echo "→ Seed idempotente (ws_dev + agentes demo)…"
pnpm --filter @core/infra run prisma:seed || echo "⚠ seed no completó; re-ejecútalo: pnpm --filter @core/infra run prisma:seed"
echo "→ Arrancando API…"
exec node apps/api/dist/main.js
