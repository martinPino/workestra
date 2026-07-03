#!/usr/bin/env bash
#
# Túnel HTTPS + arranque de la API para conectar proveedores OAuth REALES (Slack/Jira/GitHub).
# Slack exige una Redirect URL HTTPS; este script levanta un túnel a la API local, te imprime la
# Redirect URL EXACTA para pegar en la app del proveedor, y arranca la API con ese API_SELF_URL.
#
# Uso:
#   1) Copia la plantilla y pon tus credenciales:  cp .env.connectors.example .env.connectors
#   2) Ejecuta:                                     bash scripts/connectors-dev.sh
#   3) Pega la Redirect URL que imprime en tu app de Slack/Jira → Save.
#   4) Abre la UI → Integrations → Conectar.
#   Ctrl+C para parar el túnel + API + worker.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${API_PORT:-3001}"
ENV_FILE="${CONNECTORS_ENV:-.env.connectors}"

# --- 1) Credenciales del proveedor (SLACK_CLIENT_ID/SECRET, JIRA_*, GITHUB_*) ---
if [ -f "$ENV_FILE" ]; then
  echo "→ Cargando credenciales de $ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
else
  echo "⚠  No existe $ENV_FILE. Copia la plantilla:  cp .env.connectors.example $ENV_FILE"
  echo "   (Puedes continuar solo para OBTENER la Redirect URL, pero conectar exige las credenciales.)"
fi

# --- 2) Compilar API + worker si falta el dist ---
if [ ! -f apps/api/dist/main.js ] || [ ! -f apps/worker/dist/main.js ]; then
  echo "→ Compilando API + worker (dist ausente)…"
  pnpm --filter @app/api --filter @app/worker run build
fi

# --- 3) Levantar el túnel HTTPS (cloudflared preferido; ngrok como alternativa) ---
TUNNEL_LOG="$(mktemp)"
PUBLIC=""
TUNNEL_PID=""

if command -v cloudflared >/dev/null 2>&1; then
  echo "→ Abriendo túnel con cloudflared…"
  cloudflared tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  for _ in $(seq 1 30); do
    PUBLIC=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
    [ -n "$PUBLIC" ] && break
    sleep 1
  done
elif command -v ngrok >/dev/null 2>&1; then
  echo "→ Abriendo túnel con ngrok…"
  ngrok http "$PORT" --log stdout > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  for _ in $(seq 1 30); do
    PUBLIC=$(curl -s http://127.0.0.1:4040/api/tunnels \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((t['public_url'] for t in d.get('tunnels',[]) if t['public_url'].startswith('https')),''))" 2>/dev/null || true)
    [ -n "$PUBLIC" ] && break
    sleep 1
  done
else
  echo "❌ Falta una herramienta de túnel HTTPS. Instala una (cloudflared NO requiere cuenta):"
  echo "     brew install cloudflared      # recomendado"
  echo "     brew install ngrok            # alternativa (requiere: ngrok config add-authtoken <token>)"
  exit 1
fi

if [ -z "$PUBLIC" ]; then
  echo "❌ No pude obtener la URL pública del túnel. Últimas líneas del log:"
  tail -8 "$TUNNEL_LOG"
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  exit 1
fi

REDIRECT="$PUBLIC/connectors/callback"
echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Túnel HTTPS activo:   $PUBLIC"
echo ""
echo "  👉 Pega ESTA Redirect URL en tu app (Slack: OAuth & Permissions →"
echo "     Redirect URLs · Jira/Atlassian: Callback URL):"
echo ""
echo "        $REDIRECT"
echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo ""

# --- 4) Arrancar API + worker con API_SELF_URL = URL del túnel ---
API_PID=""; WORKER_PID=""
cleanup() {
  echo ""
  echo "→ Parando túnel + API + worker…"
  for pid in "$TUNNEL_PID" "$API_PID" "$WORKER_PID"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

export API_SELF_URL="$PUBLIC"
export API_PORT="$PORT"
export PERSISTENCE="${PERSISTENCE:-postgres}"
export DATABASE_URL="${DATABASE_URL:-postgresql://agentflow:agentflow@localhost:5432/agentflow?schema=public}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export WEB_URL="${WEB_URL:-http://localhost:5173}"
export KMS_MASTER_KEY="${KMS_MASTER_KEY:-dev-only-32-byte-key-change-me!!}"
export JWT_SECRET="${JWT_SECRET:-dev-secret}"

# Detener cualquier API previa en el puerto para que la nueva use el API_SELF_URL correcto.
lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
sleep 1

echo "→ Arrancando API (API_SELF_URL=$PUBLIC) + worker…"
node apps/api/dist/main.js & API_PID=$!
node apps/worker/dist/main.js & WORKER_PID=$!

echo "→ Todo arriba. Abre la UI → Integrations → Slack → Conectar."
echo "   (Ctrl+C para parar túnel + API + worker)"
wait
