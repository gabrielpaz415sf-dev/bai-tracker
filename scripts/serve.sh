#!/bin/bash
# Always-on dashboard. Launched by the com.bai-tracker.server launchd agent at
# login and kept alive across crashes and restarts.
#
# Rebuilds before starting so the bundle served at localhost:8787 always matches
# the current source — a stale dist is the one failure mode that produces a page
# which looks fine and is wrong. The build costs a few seconds and runs once per
# login, not per request.
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

npm run build
exec npm start
