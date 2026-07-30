#!/bin/bash
# One-shot key installer: writes the provider keys into .env, restarts the
# dashboard, and reports whether they actually took effect.
#
# Usage:
#   ./scripts/set-keys.sh <MARKETAUX_KEY> <EODHD_KEY>
#   ./scripts/set-keys.sh --marketaux <KEY>
#   ./scripts/set-keys.sh --eodhd <KEY>
#
# Verifying is the point. A typo'd key does not crash anything — the provider
# just returns an auth error, the app degrades to "no explanations available",
# and it looks identical to not having set the key at all. So this reads the
# live state back and says which of the two is actually working.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$REPO/.env"
PORT="${PORT:-8787}"

MARKETAUX=""
EODHD=""

case "${1:-}" in
  --marketaux) MARKETAUX="${2:-}" ;;
  --eodhd)     EODHD="${2:-}" ;;
  "")          echo "usage: $0 <MARKETAUX_KEY> <EODHD_KEY>" >&2; exit 1 ;;
  *)           MARKETAUX="${1:-}"; EODHD="${2:-}" ;;
esac

# Replace the KEY= line in place. Keys are alphanumeric, but route the value
# through the environment rather than the sed script so a stray / or & in a
# vendor key cannot corrupt the file.
set_key() {
  local name="$1" value="$2"
  [ -z "$value" ] && return 0
  if grep -qE "^${name}=" "$ENV"; then
    NEW_VALUE="$value" perl -pi -e "s/^\Q${name}\E=.*/\$ENV{NEW_VALUE} ? \"${name}=\$ENV{NEW_VALUE}\" : \$&/e" "$ENV"
  else
    printf '%s=%s\n' "$name" "$value" >> "$ENV"
  fi
  echo "  set ${name}"
}

echo "Updating $ENV"
set_key MARKETAUX_API_KEY "$MARKETAUX"
set_key EODHD_API_KEY "$EODHD"

echo "Restarting dashboard…"
launchctl kickstart -k "gui/$(id -u)/com.bai-tracker.server" >/dev/null 2>&1
for _ in $(seq 1 45); do
  curl -sf "http://localhost:$PORT/api/health" -o /dev/null && break
  sleep 1
done

echo
echo "Result:"
curl -s "http://localhost:$PORT/api/live" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try {
    const j = JSON.parse(d).live;
    console.log('  news / \"why\"     : ' + (j.newsSource.available
      ? 'WORKING — ' + j.newsSource.label
      : 'not working — ' + j.newsSource.note));
  } catch (e) { console.log('  could not read live state:', e.message); }
});"
# Deliberately the attribution figure, not the live one. Live coverage counts
# only US names — foreign venues are closed during the US session and are
# reported separately — so it sits near 77% no matter how good the key is, and
# reading it as "EODHD failed" is exactly the wrong conclusion.
curl -s "http://localhost:$PORT/api/attribution?timeframe=1M" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try {
    const a = JSON.parse(d).attribution;
    console.log('  price coverage   : ' + a.coveragePct.toFixed(1) + '% of fund weight' +
      (a.coveragePct > 90 ? '  (foreign holdings priced)' : '  (foreign holdings still missing)'));
  } catch (e) { console.log('  could not read attribution:', e.message); }
});"
echo
echo "Public link: $(cat "$REPO/briefs/tunnel-url.txt" 2>/dev/null || echo 'tunnel not running')"
