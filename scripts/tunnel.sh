#!/bin/bash
# Cloudflare quick tunnel: publishes the local dashboard on a public
# https://<random>.trycloudflare.com URL.
#
# Quick tunnels need no Cloudflare account, and the trade is that the hostname
# is assigned fresh on every start. So the URL is scraped out of cloudflared's
# own startup output and written to briefs/tunnel-url.txt, which is the one
# place to look for "what is the link right now".
#
# The dashboard behind this is password-protected: server/src/index.ts demands
# basic auth on any request carrying Cloudflare's CF-Ray header. Refuse to
# publish without that configured — an open URL leaks the fund view and, more
# practically, lets a crawler burn the ~45 req/hour Tiingo allowance.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
URL_FILE="$REPO/briefs/tunnel-url.txt"
PORT="${PORT:-8787}"

if ! grep -qE '^BAI_AUTH_PASS=.+' "$REPO/.env" 2>/dev/null; then
  echo "[tunnel] refusing to start: BAI_AUTH_PASS is empty in .env." >&2
  echo "[tunnel] set a password first — this URL is public to anyone who has it." >&2
  exit 1
fi

# Wait for the dashboard itself; launchd may start both agents at once.
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/api/health" -o /dev/null && break
  sleep 2
done

echo "[tunnel] starting quick tunnel → http://localhost:$PORT"

# cloudflared prints the assigned hostname during startup, and prints a NEW one
# every time it reconnects after Cloudflare drops the control stream. The first
# version of this script only captured the first hostname, so after a reconnect
# tunnel-url.txt held a name that no longer resolved — and because the process
# was still alive, nothing looked wrong. Match on every occurrence.
#
# Piping into `while read` runs the loop in a subshell, so nothing is assigned to
# a variable the rest of the script needs; the file is the shared state.
# --protocol http2 rather than the default QUIC. QUIC rides UDP/7844, which many
# home and cafe networks rate-limit or drop; the log filled with
#   ERR failed to run the datagram handler error="timeout: no recent network activity"
# and cloudflared reconnected every few minutes. Each reconnect risks a new
# hostname, which is what kept killing the link. HTTP/2 rides TCP/443 and stays up.
"$REPO/bin/cloudflared" tunnel --no-autoupdate --protocol http2 \
  --url "http://localhost:$PORT" 2>&1 |
  while IFS= read -r line; do
    echo "$line"

    # Cloudflare expires quick tunnels after a few hours. When it does,
    # cloudflared does NOT exit — it retries forever against a tunnel that no
    # longer exists, logging "Unauthorized: Tunnel not found" while the URL
    # serves nothing. Because the process stays alive, launchd's KeepAlive never
    # fires and the link is dead with everything apparently "running". Exiting
    # here hands control back to launchd, which restarts us and provisions a
    # genuinely new tunnel.
    if [[ "$line" == *"Tunnel not found"* ]]; then
      echo "[tunnel] quick tunnel expired — exiting so launchd provisions a new one"
      rm -f "$URL_FILE"   # never leave a stale hostname behind
      exit 1
    fi

    if [[ "$line" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
      url="${BASH_REMATCH[1]}"
      if [ "$(cat "$URL_FILE" 2>/dev/null)" != "$url" ]; then
        printf '%s\n' "$url" > "$URL_FILE"
        printf '%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$url" >> "$REPO/briefs/tunnel-history.tsv"
        echo "[tunnel] PUBLIC URL: $url  (saved to $URL_FILE)"

        # Prove it actually answers. A live process is not a live tunnel, and
        # that distinction is exactly what went unnoticed before. Backgrounded
        # so the probe never stalls cloudflared's own output.
        (
          sleep 4
          code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
                 -H 'CF-Ray: selfcheck' "$url/api/health" 2>/dev/null)
          # 401 is success here: the tunnel reached us and basic auth answered.
          case "$code" in
            401|200) echo "[tunnel] self-check OK (HTTP $code) — $url" ;;
            *)       echo "[tunnel] self-check FAILED (HTTP ${code:-000}) — $url is not serving" ;;
          esac
        ) &
      fi
    fi
  done
