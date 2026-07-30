#!/bin/bash
# ngrok tunnel with a reserved (permanent) hostname.
#
# This exists because Cloudflare quick tunnels cannot give a stable URL: they
# expire after a few hours and are reassigned a new random hostname each time.
# ngrok's free tier includes one reserved domain, so the link stays valid across
# restarts, reboots and expiries — which is the whole point of using it here.
#
# Requires in .env:
#   NGROK_AUTHTOKEN   dashboard.ngrok.com/get-started/your-authtoken
#   NGROK_DOMAIN      dashboard.ngrok.com/domains  (e.g. foo-bar.ngrok-free.app)
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
URL_FILE="$REPO/briefs/tunnel-url.txt"
PORT="${PORT:-8787}"

# shellcheck disable=SC1091
set -a; [ -f "$REPO/.env" ] && . "$REPO/.env"; set +a

if [ -z "${NGROK_AUTHTOKEN:-}" ] || [ -z "${NGROK_DOMAIN:-}" ]; then
  echo "[ngrok] NGROK_AUTHTOKEN / NGROK_DOMAIN not set in .env — nothing to do." >&2
  exit 1
fi

# Same refusal as the Cloudflare script: never publish an unprotected origin.
# The free market-data tiers are small enough that one crawler exhausts them.
if ! grep -qE '^BAI_ACCESS_TOKEN=.+' "$REPO/.env" 2>/dev/null; then
  echo "[ngrok] refusing to start: BAI_ACCESS_TOKEN is empty in .env." >&2
  exit 1
fi

"$REPO/bin/ngrok" config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null 2>&1

# Wait for the dashboard; launchd may start both agents at once.
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/api/health" -o /dev/null && break
  sleep 2
done

# The hostname is reserved, so it is known before ngrok even starts — no need to
# scrape it out of the logs the way the quick tunnel required.
printf 'https://%s\n' "$NGROK_DOMAIN" > "$URL_FILE"
echo "[ngrok] PUBLIC URL: https://$NGROK_DOMAIN"

exec "$REPO/bin/ngrok" http "$PORT" \
  --domain "$NGROK_DOMAIN" \
  --log stdout --log-format logfmt
