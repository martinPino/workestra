#!/usr/bin/env bash
#
# Provisión de Cloudflare para el API (docs/CLOUDFLARE.md, «Lo que falta para servir producción»).
#
# NO se ejecuta solo ni en CI: crea recursos de pago en una cuenta real y escribe secretos. Se corre a
# mano, una vez, cuando ya están tomadas las decisiones que pide la sección de REQUISITOS.
#
#   bash scripts/cloudflare-provision.sh 'postgresql://usuario:clave@host/base?sslmode=require'
#
# Es idempotente en lo que se puede: crear un bucket que ya existe no rompe, y los secretos se
# sobrescriben. Lo único que NO es idempotente es `hyperdrive create`: si ya hay uno, reutiliza su id
# en vez de crear otro.
set -euo pipefail

cd "$(dirname "$0")/.."
API_DIR="apps/api"

PG_URL="${1:-}"
if [ -z "$PG_URL" ]; then
  cat <<'USO'
Falta la cadena de conexión de Postgres.

  bash scripts/cloudflare-provision.sh 'postgresql://usuario:clave@host/base?sslmode=require'

REQUISITOS previos (decisiones, no comandos):

  1. Un Postgres gestionado (Neon, Supabase, RDS…) con el esquema ya migrado. Hyperdrive es un POOL:
     no guarda datos, solo acelera el acceso a una base que ya existe. El Postgres de Railway está
     con el deployment REMOVED, así que hay que revivirlo o crear uno nuevo y restaurar.

  2. R2 habilitado en el panel de Cloudflare (Dashboard → R2 → Enable). Por API sale
     «code 10042: Please enable R2 through the Cloudflare Dashboard» y no se puede hacer desde aquí.

  3. Plan Workers Paid ($5/mes) si se quieren Workflows (la ejecución durable) y Containers (fase 5).

  4. KMS_MASTER_KEY: TIENE que ser el MISMO valor que usaba Railway. Cifra los tokens de conectores
     con AES-GCM; con otro valor quedan indescifrables y todo el mundo tiene que reconectar sus
     integraciones. Es el único dato de la migración que no se puede regenerar.
USO
  exit 1
fi

echo "==> 1/4  Hyperdrive (pool de Postgres del lado de Cloudflare)"
EXISTING=$(npx wrangler hyperdrive list 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1 || true)
if [ -n "$EXISTING" ]; then
  echo "    ya existe uno: $EXISTING (se reutiliza)"
  HYPERDRIVE_ID="$EXISTING"
else
  HYPERDRIVE_ID=$(npx wrangler hyperdrive create workestra-db --connection-string="$PG_URL" 2>&1 | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$HYPERDRIVE_ID" ] || { echo "    ERROR: no pude crear la config de Hyperdrive"; exit 1; }
  echo "    creada: $HYPERDRIVE_ID"
fi

echo "    pegando el id en $API_DIR/wrangler.jsonc"
python3 - "$API_DIR/wrangler.jsonc" "$HYPERDRIVE_ID" <<'PY'
import re, sys
path, hid = sys.argv[1], sys.argv[2]
s = open(path, encoding='utf-8').read()
s2 = re.sub(r'("binding":\s*"HYPERDRIVE",\s*"id":\s*)"[^"]*"', r'\1"%s"' % hid, s)
if s2 == s:
    print("    OJO: no encontré el binding de HYPERDRIVE; pégalo a mano")
else:
    open(path, 'w', encoding='utf-8').write(s2)
PY

echo "==> 2/4  Bucket R2 + caducidad de 48 h"
# La caducidad de los ficheros de ejecución (M48) es una LIFECYCLE RULE, no código: sin ella el bucket
# crece para siempre.
npx wrangler r2 bucket create workestra-files 2>&1 | tail -1 || echo "    (ya existía)"
npx wrangler r2 bucket lifecycle add workestra-files \
  --name expira-ficheros-de-ejecucion --prefix file/ --expire-days 2 2>&1 | tail -1 || \
  echo "    OJO: no pude poner la lifecycle rule; ponla a mano o el bucket crece sin límite"

echo "==> 3/4  Secretos"
echo "    Se piden por stdin: no quedan en el historial del shell ni en el repo."
cd "$API_DIR"
for s in JWT_SECRET KMS_MASTER_KEY; do
  echo "    --> $s"
  npx wrangler secret put "$s"
done
cat <<'OPC'
    Opcionales, según lo que esté conectado (ponlos con `npx wrangler secret put <NOMBRE>` desde apps/api):
      BREVO_API_KEY o RESEND_API_KEY   — invitaciones de equipo
      SLACK_CLIENT_SECRET              — conector de Slack
      JIRA_CLIENT_SECRET               — conector de Jira
      GITHUB_CLIENT_SECRET             — conector de GitHub
OPC

echo "==> 4/4  Comprobación previa al despliegue"
npx wrangler deploy --dry-run >/dev/null && echo "    el Worker empaqueta"
cd - >/dev/null
pnpm --filter @app/api test:workers >/dev/null 2>&1 && echo "    el Worker arranca en workerd"

cat <<'FIN'

Listo lo automatizable. ANTES de abrir el dominio al público, queda una cosa que no es un comando:

  RATE LIMITING. El middleware del API cuenta por isolate, no globalmente, así que en Cloudflare es
  más débil que en Railway. La barrera de verdad son las Rate Limiting Rules o el WAF, y se
  configuran en el panel (Security → WAF → Rate limiting rules). Sin eso, /auth/login queda expuesta
  a fuerza bruta distribuida.

Después:  cd apps/api && npx wrangler deploy
FIN
