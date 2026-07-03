#!/usr/bin/env sh
# Arranque de la API en producción: aplica migraciones y luego escucha.
# `migrate deploy` es idempotente (no hace nada si no hay migraciones pendientes).
set -e
echo "→ Aplicando migraciones (prisma migrate deploy)…"
pnpm --filter @core/infra run prisma:deploy
echo "→ Arrancando API…"
exec node apps/api/dist/main.js
