#!/usr/bin/env sh
# Entrypoint ÚNICO del contenedor. Cada servicio de Railway fija la variable de entorno
# SERVICE=api|worker|web (las variables SÍ se aplican de forma fiable, a diferencia del "custom
# start command", que en monorepos a veces no se propaga). Así los tres servicios usan la misma
# imagen y el mismo CMD, y solo cambia una variable.
set -e
SERVICE="${SERVICE:-api}"
echo "→ Iniciando servicio: $SERVICE"

case "$SERVICE" in
  worker)
    exec node apps/worker/dist/main.js
    ;;
  web)
    exec node apps/web/serve.mjs
    ;;
  api|*)
    echo "→ Migraciones (prisma migrate deploy)…"
    pnpm --filter @core/infra run prisma:deploy
    echo "→ Seed idempotente (ws_dev + agentes demo)…"
    pnpm --filter @core/infra run prisma:seed || echo "⚠ seed no completó; re-ejecútalo a mano si hace falta"
    echo "→ Arrancando API…"
    exec node apps/api/dist/main.js
    ;;
esac
