#!/bin/bash
# Installs the always-on dashboard as a launchd user agent, so
# http://localhost:8787 is up from login without a terminal open.
#
# Idempotent: safe to re-run after editing the plist or moving the repo.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.bai-tracker.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/briefs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/serve.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Back off instead of spinning if the server dies on startup. -->
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$REPO/briefs/server.log</string>
  <key>StandardErrorPath</key><string>$REPO/briefs/server.log</string>
</dict>
</plist>
PLIST_EOF

# bootout first so a re-run picks up plist edits rather than keeping the old
# definition loaded. Failure here just means it wasn't loaded yet.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed $LABEL"
echo "  dashboard: http://localhost:8787  (takes ~10s on first start — it builds)"
echo "  logs:      $REPO/briefs/server.log"
echo "  stop:      launchctl bootout gui/$(id -u)/$LABEL"
